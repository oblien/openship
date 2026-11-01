"use client";

import type { IssueScope, SystemIssue } from "@/lib/api/issues";
import { useI18n } from "@/components/i18n-provider";
import AlertPanel from "@/components/overview/AlertPanel";
import { IssueRow } from "./IssueRow";
import { SCOPE_ICON, panelTone } from "./issueMeta";

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
  standAlone,
  busyIds,
  onResolve,
  onInfraFix,
  onRecheck,
  rechecking,
}: {
  scope: IssueScope;
  issues: SystemIssue[];
  /** True when nothing louder than an advisory is anywhere on the page — an
   *  advisory panel then wears amber instead of the muted surface. */
  standAlone: boolean;
  busyIds: ReadonlySet<string>;
  onResolve: (issue: SystemIssue) => void;
  onInfraFix: (issue: SystemIssue) => void;
  onRecheck?: () => void;
  rechecking?: boolean;
}) {
  const { t } = useI18n();
  const c = t.issues;
  if (issues.length === 0) return null;

  return (
    <AlertPanel
      tone={panelTone(issues[0]!.severity, standAlone)}
      density="comfortable"
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
            density="comfortable"
            busy={busyIds?.has(issue.id) ?? false}
            onResolve={onResolve}
            onInfraFix={onInfraFix}
            onRecheck={onRecheck}
            rechecking={rechecking}
          />
        ))}
      </ul>
    </AlertPanel>
  );
}
