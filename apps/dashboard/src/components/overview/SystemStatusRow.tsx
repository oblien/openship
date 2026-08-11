"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";

import type { SystemIssue } from "@/lib/api/issues";
import { useI18n, interpolate } from "@/components/i18n-provider";

/**
 * The Activity card's bottom line: is this installation serving or not.
 *
 * It replaces a lifetime deployment success rate, which was a number nobody acts on —
 * 50% could mean two deploys last year, and it said nothing about whether anything is
 * up right now.
 *
 * Reads the SAME `/issues` feed the attention cards do (passed down, not fetched
 * again), and stays a roll-up: a count and a way in, never a restatement of the rows.
 * Two rules keep it from duplicating the cards beside it:
 *
 *   - Advisories don't count. An available update is not a fault, so a pending release
 *     leaves this row reading "Operational" and the Updates card keeps that subject to
 *     itself.
 *   - Both cards showing means the Activity card isn't rendered at all, so at most one
 *     alert panel is ever on screen with this line.
 *
 * It also closes the gap the cards can't: there is no card for "nothing is wrong", and
 * a hidden attention card leaves this row as the only thing still saying "2 issues".
 */
export default function SystemStatusRow({
  broken,
  loaded,
}: {
  /** Outage + action-required issues — the feed's `broken` split, advisories excluded. */
  broken: SystemIssue[];
  /** False until `/issues` has answered: an unread feed must not claim "Operational". */
  loaded: boolean;
}) {
  const { t } = useI18n();
  const c = t.dashboard.home;

  const down = broken.some((i) => i.severity === "outage");
  const tone = !loaded
    ? "text-muted-foreground"
    : broken.length === 0
      ? "text-success"
      : down
        ? "text-danger"
        : "text-warning";

  const Icon = loaded && broken.length > 0 ? AlertTriangle : CheckCircle2;
  const value = !loaded
    ? "–"
    : broken.length === 0
      ? c.operational
      : broken.length === 1
        ? c.oneIssue
        : interpolate(c.manyIssues, { n: String(broken.length) });

  // min-w-0 + truncate on the label, shrink-0 on the value: the longest translation
  // ("Systemstatus" / "Alles betriebsbereit") shortens the label rather than wrapping
  // the row or pushing the count out of a ~320px column.
  const body = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={`size-4 shrink-0 ${tone}`} />
        <span className="truncate text-sm text-muted-foreground">{c.systemStatus}</span>
      </div>
      <span className={`inline-flex shrink-0 items-center gap-1 text-sm font-medium ${tone}`}>
        {value}
        {loaded && broken.length > 0 && <ArrowRight className="size-3.5 rtl:rotate-180" />}
      </span>
    </>
  );

  // Only a link when there's something to look at. The hover chip stays inside the
  // card's padding so it never bleeds into the border.
  if (!loaded || broken.length === 0) {
    return <div className="flex items-center justify-between">{body}</div>;
  }

  return (
    <Link
      href="/issues"
      className="-mx-2 flex items-center justify-between rounded-lg px-2 py-1 transition-colors hover:bg-muted/40"
    >
      {body}
    </Link>
  );
}
