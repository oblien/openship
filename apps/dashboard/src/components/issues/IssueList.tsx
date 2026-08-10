"use client";

import { useMemo } from "react";

import type { IssueScope, SystemIssue } from "@/lib/api/issues";
import { IssueGroup } from "./IssueGroup";
import { SCOPE_ORDER } from "./issueMeta";

/**
 * The feed's body: rows bucketed into their scope's panel, in blast-radius order.
 *
 * Pure presentation — it takes the list it is given and never fetches or filters.
 * That's what lets the page, the fixture preview and the render test all exercise
 * the same grouping instead of each arranging rows its own way.
 */
export function IssueList({
  issues,
  busyId,
  onResolve,
  onInfraFix,
}: {
  issues: SystemIssue[];
  busyId: string | null;
  onResolve: (issue: SystemIssue) => void;
  onInfraFix: (issue: SystemIssue) => void;
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
    return out;
  }, [issues]);

  return (
    <div className="space-y-4">
      {SCOPE_ORDER.map((scope) => (
        <IssueGroup
          key={scope}
          scope={scope}
          issues={grouped.get(scope) ?? []}
          busyId={busyId}
          onResolve={onResolve}
          onInfraFix={onInfraFix}
        />
      ))}
    </div>
  );
}
