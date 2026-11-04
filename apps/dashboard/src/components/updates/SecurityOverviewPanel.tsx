"use client";

import { useState } from "react";
import Link from "next/link";
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
  const { t, locale } = useI18n();
  const copy = t.projectSettings.securityAdvisories;
  const hostCopy = t.projectSettings.hostSecurity;
  const resourceKey = useCloudResourceKey();
  const [showOther, setShowOther] = useState(false);
  const scan = overview.scan;
  const task = (
    <div className="rounded-xl bg-muted/40 p-4 text-sm space-y-1" role="status">
      <p className="font-medium">{hostCopy.scanTask}</p>
      <p className="text-muted-foreground">
        {overview.checksEnabled === false || scan?.schedulerEnabled === false
          ? hostCopy.schedulerPaused
          : (hostCopy.scanStates[(scan?.status ?? "pending") as keyof typeof hostCopy.scanStates] ??
            hostCopy.scanStates.pending)}
      </p>
      {scan?.finishedAt && (
        <p className="text-xs text-muted-foreground">
          {hostCopy.lastRun}:{" "}
          {new Date(scan.finishedAt).toLocaleString(locale ?? "en", {
            timeZone: "UTC",
            timeZoneName: "short",
          })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {hostCopy.scanHint} {scan?.schedule && <code>{scan.schedule}</code>}{" "}
        {scan?.runsWhileAppOpen && hostCopy.appOpen}
      </p>
      <Link href="/settings?tab=notifications" className="inline-block text-xs underline">
        {copy.manageChecks}
      </Link>
    </div>
  );
  if (overview.checksEnabled === false)
    return (
      <div className="space-y-3 text-sm text-muted-foreground">
        {task}
        <p role="status">{copy.checksDisabled}</p>
        <Button variant="secondary" size="sm" asChild>
          <Link href="/settings?tab=notifications">{copy.manageChecks}</Link>
        </Button>
      </div>
    );
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
      {task}
      {(overview.servers ?? [])
        .filter((s) => s.supported)
        .map((server) => (
          <div key={server.serverId} className="rounded-xl bg-card p-4 space-y-2">
            <h3 className="text-sm font-medium">{server.name}</h3>
            {server.pending && (
              <p className="text-sm text-muted-foreground">{hostCopy.checkPending}</p>
            )}
            {server.error && <p className="text-sm text-muted-foreground">{copy.unavailable}</p>}
            {server.findings.map((f) => (
              <p key={f.id} className="text-sm">
                {f.title}
                {f.state === "reboot_required" && <> · {hostCopy.rebootRequired}</>}
              </p>
            ))}
            <Link
              href={`/servers/${encodeURIComponent(server.serverId)}?tab=runs`}
              className="text-sm underline"
            >
              {hostCopy.openRuns}
            </Link>
          </div>
        ))}
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>{copy.affected}</p>
        {!!overview.pendingProjects && (
          <p>{interpolate(copy.pendingApps, { count: overview.pendingProjects })}</p>
        )}
        {!!overview.unknownProjects && <p>{copy.partial}</p>}
        {overview.projects.some((project) => project.feedStale || project.feedError) && (
          <p role="status">{copy.unavailable}</p>
        )}
        {!affected.length &&
          !overview.pendingProjects &&
          !(overview.servers ?? []).some((s) => s.pending || s.error || s.findings.length) && (
            <p>{copy.noMatches}</p>
          )}
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
