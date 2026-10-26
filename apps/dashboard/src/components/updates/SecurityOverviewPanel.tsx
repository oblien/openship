"use client";

import { useState } from "react";
import type { SecurityOverview } from "@repo/contracts";
import { SECURITY_FEED_SOURCE } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { Button } from "@/components/ui/button";
import { SecurityProjectReview } from "./SecurityProjectReview";

/** The same resource-scoped review in Monitoring, Settings and the banner dialog. */
export function SecurityOverviewPanel({
  overview,
  onChecked,
}: {
  overview: SecurityOverview;
  onChecked: () => void;
}) {
  const { t } = useI18n();
  const copy = t.projectSettings.securityAdvisories;
  const resourceKey = useCloudResourceKey();
  const [showOther, setShowOther] = useState(false);
  const affected = overview.projects.filter(
    (project) => project.findings.length || project.autoRefresh,
  );
  const other = overview.projects.filter(
    (project) => !project.findings.length && !project.autoRefresh,
  );
  const renderProject = (project: SecurityOverview["projects"][number]) => (
    <SecurityProjectReview
      key={`${resourceKey}:${project.projectId}:${project.deploymentId}`}
      projectId={project.projectId}
      name={project.name}
      workspaceId={project.workspaceId}
      revision={project.deploymentId}
      initialResult={project}
      onChecked={onChecked}
    />
  );
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>{copy.affected}</p>
        {!!overview.pendingProjects && (
          <p>{interpolate(copy.pendingApps, { count: overview.pendingProjects })}</p>
        )}
        {!!overview.unknownProjects && <p>{copy.partial}</p>}
        {overview.projects.some((project) => project.feedStale || project.feedError) && (
          <p role="status">{copy.unavailable}</p>
        )}
        {!affected.length && !overview.pendingProjects && <p>{copy.noMatches}</p>}
      </div>
      {affected.map(renderProject)}
      {!!other.length && (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showOther}
            onClick={() => setShowOther(!showOther)}
          >
            {interpolate(copy.otherApps, { count: other.length })}
          </Button>
          {showOther && other.map(renderProject)}
        </>
      )}
      <a
        href={SECURITY_FEED_SOURCE}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-xs text-muted-foreground underline underline-offset-4"
      >
        {copy.publicFeed}
      </a>
    </div>
  );
}
