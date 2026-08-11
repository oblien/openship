"use client";

/**
 * Variant switcher around the issue feed's body, driven entirely by fixtures.
 *
 * The feed only has rows when real infrastructure is broken, so reviewing its layout
 * otherwise means stopping containers and taking a box offline. Each variant is a
 * state that is awkward to produce on demand:
 *
 *   mixed     — mid-incident: something in every scope, worst first
 *   outage    — all red: the page must stay scannable, not become a wall
 *   action    — nothing down, but five things want an answer: no danger anywhere
 *   advisory  — nothing broken, only things behind: no panel may read as an alarm
 *   resolved  — history rows: a recovery clock and no fix to offer
 *   fleet     — 40 rows: density and whether the group headers still orient you
 *   empty     — the state an operator should see most of the time
 *
 * The last three are the empty state's three variants, which is the only place they can
 * be seen: two of them need an impossible combination of live data (rows that exist but
 * all fail a filter; a resolved tab whose 30-day window happens to be empty), and none
 * of them can be checked for theme or `ar` RTL from a render test.
 */

import { useState } from "react";

import { EmptyIssues } from "@/components/issues/EmptyIssues";
import { IssueList } from "@/components/issues/IssueList";
import { IssueSummary } from "@/components/issues/IssueSummary";
import { ISSUE_FIXTURES, countFixtures } from "@/components/issues/issue-fixtures";

type Variant =
  | "mixed"
  | "outage"
  | "action"
  | "advisory"
  | "resolved"
  | "fleet"
  | "empty"
  | "empty-resolved"
  | "empty-filtered";

const VARIANTS: Array<{ id: Variant; label: string; note: string }> = [
  { id: "mixed", label: "Mixed", note: "every scope at once — platform, server, project, domain" },
  { id: "outage", label: "All outage", note: "four red rows: the panels must not blur together" },
  { id: "action", label: "Action needed", note: "setup gaps and held decisions — no danger anywhere" },
  { id: "advisory", label: "Advisory only", note: "neutral tone — an update is not an alarm" },
  { id: "resolved", label: "Resolved", note: "history: recovery clock, no action offered" },
  { id: "fleet", label: "40 rows", note: "density check across four group panels" },
  { id: "empty", label: "Empty", note: "no groups render at all — the page shows its empty state" },
  {
    id: "empty-resolved",
    label: "Empty · resolved",
    note: "history is empty — must not read as 'your fleet is healthy'",
  },
  {
    id: "empty-filtered",
    label: "Empty · filtered",
    note: "rows exist, none match — narrow column, beside the summary rail",
  },
];

export function IssuesPreview() {
  const [variant, setVariant] = useState<Variant>("mixed");
  const issues = ISSUE_FIXTURES[variant] ?? [];
  const counts = countFixtures(issues);
  const note = VARIANTS.find((v) => v.id === variant)!.note;

  return (
    <div className="space-y-5 p-5">
      <div className="rounded-2xl border border-warning-border bg-warning-bg p-4">
        <p className="text-sm font-medium text-foreground">
          Issue feed — fixtures, not real data
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Dev-only route; 404s in a production build. Nothing here reads the API and no action
          leaves this page. Check every theme and `ar` RTL: severity lives in the panel border
          and header, so an outage and an advisory have to be distinguishable at a glance.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {VARIANTS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setVariant(v.id)}
              aria-pressed={variant === v.id}
              className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                variant === v.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground/80">{note}</p>
        <p className="mt-1 text-xs tabular-nums text-muted-foreground/80">
          {counts.outage} outage · {counts.actionRequired} action needed · {counts.advisory} advisory
        </p>
      </div>

      {variant === "empty-filtered" ? (
        // Mounted exactly as the live page mounts it: inside `1fr` of the two-column
        // grid, with the rail populated (rows DO exist here) and the `0 / n` counter and
        // reset below it — the only things telling the operator how much is hidden.
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          <div className="min-w-0">
            <EmptyIssues filtered resolved={false} />
            <div className="mt-4 flex items-center gap-3">
              <p className="text-[12px] tabular-nums text-muted-foreground/70">
                0 / {ISSUE_FIXTURES.mixed.length}
              </p>
              <button
                type="button"
                className="text-[12px] font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                Clear filters
              </button>
            </div>
          </div>
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <IssueSummary issues={ISSUE_FIXTURES.mixed} tab="open" />
          </div>
        </div>
      ) : issues.length === 0 ? (
        <EmptyIssues filtered={false} resolved={variant === "empty-resolved"} />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          <div className="min-w-0">
            <IssueList issues={issues} busyId={null} onResolve={() => {}} onInfraFix={() => {}} />
          </div>
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <IssueSummary issues={issues} tab={variant === "resolved" ? "resolved" : "open"} />
          </div>
        </div>
      )}
    </div>
  );
}
