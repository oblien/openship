"use client";

import { useMemo } from "react";

import type { IssueScope, SystemIssue } from "@/lib/api/issues";
import { IssueGroup } from "./IssueGroup";
import { SCOPE_ORDER } from "./issueMeta";

/**
 * The feed's body: scope panels needing attention precede advisory-only panels.
 * Within either tier, scope order and the server's row order are preserved.
 *
 * Pure presentation — it takes the list it is given and never fetches or filters.
 * That's what lets the page, the fixture preview and the render test all exercise
 * the same grouping instead of each arranging rows its own way.
 */
export function IssueList({
  issues,
  busyIds,
  onResolve,
  onInfraFix,
  onRecheck,
  rechecking,
}: {
  issues: SystemIssue[];
  busyIds: ReadonlySet<string>;
  onResolve: (issue: SystemIssue) => void;
  onInfraFix: (issue: SystemIssue) => void;
  onRecheck?: () => void;
  rechecking?: boolean;
}) {
  // Insertion order is preserved per bucket, so the server's severity ranking
  // survives grouping and each panel's first row is its worst.
  const grouped = useMemo(() => {
    const out = new Map<IssueScope, SystemIssue[]>();
    for (const issue of issues) {
      const list = out.get(issue.scope);
      if (list) list.push(issue);
      else out.set(issue.scope, [issue]);
    }
    const groups = SCOPE_ORDER.filter((scope) => out.has(scope)).map((scope) => ({
      scope,
      issues: out.get(scope)!,
    }));
    const needsAttention = (group: (typeof groups)[number]) =>
      group.issues.some((issue) => issue.severity !== "advisory");
    return groups.sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)));
  }, [issues]);

  // Advisories wear the amber Updates identity only when nothing louder shares the
  // page; with an outage or action-required row present they stay muted so the
  // tiers don't blur. Judged across the whole feed, not per scope panel.
  const advisoriesStandAlone = useMemo(
    () => !issues.some((i) => i.severity !== "advisory"),
    [issues],
  );

  return (
    <div className="space-y-4">
      {grouped.map(({ scope, issues: rows }) => (
        <IssueGroup
          key={scope}
          scope={scope}
          issues={rows}
          standAlone={advisoriesStandAlone}
          busyIds={busyIds}
          onResolve={onResolve}
          onInfraFix={onInfraFix}
          onRecheck={onRecheck}
          rechecking={rechecking}
        />
      ))}
    </div>
  );
}
