"use client";

import type { IssueScope, SystemIssue } from "@/lib/api/issues";
import { useI18n } from "@/components/i18n-provider";
import AlertPanel from "@/components/overview/AlertPanel";
import { IssueRow } from "./IssueRow";
import { SCOPE_ICON, SEVERITY_TONE } from "./issueMeta";

/**
 * One scope's panel — the single level of grouping this surface has.
 *
 * The panel's tone is the WORST severity inside it, not an average: a card whose
 * header says "advisory" while it contains an outage is the failure mode this page
 * exists to prevent. Items arrive pre-sorted by the server, so the first one is the
 * worst and no re-ranking happens here.
 */
export function IssueGroup({
  scope,
  issues,
  busyId,
  onResolve,
  onInfraFix,
}: {
  scope: IssueScope;
  issues: SystemIssue[];
  busyId: string | null;
  onResolve: (issue: SystemIssue) => void;
  onInfraFix: (issue: SystemIssue) => void;
}) {
  const { t } = useI18n();
  const c = t.issues;
  if (issues.length === 0) return null;

  return (
    <AlertPanel
      tone={SEVERITY_TONE[issues[0]!.severity] ?? "warning"}
      icon={SCOPE_ICON[scope]}
      title={c.scopes[scope]}
      subtitle={c.scopeSubtitles[scope]}
      count={issues.length}
    >
      <ul className="divide-y divide-border/50">
        {issues.map((issue) => (
          <IssueRow
            key={issue.id}
            issue={issue}
            busy={busyId === issue.id}
            onResolve={onResolve}
            onInfraFix={onInfraFix}
          />
        ))}
      </ul>
    </AlertPanel>
  );
}
