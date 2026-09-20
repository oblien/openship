"use client";

import { useCallback, useEffect, useState } from "react";

import { useI18n } from "@/components/i18n-provider";
import { systemApi } from "@/lib/api";
import { dockerMigrationApi, type MigrationRun } from "@/lib/api/server-migration";
import { MigrationRunList, isRunInFlight } from "./MigrationRunList";

/**
 * This project's past migrations, under its migration card.
 *
 * The same history a server's Migrations tab shows, asked from the other side — one endpoint,
 * one row component, two viewpoints (see `MigrationRunList`). Without it the project side was
 * write-only: you could start a move and watch it, but once it finished there was no trace of it
 * anywhere near the project it happened to, and reopening a parked run meant knowing which
 * server to go looking on.
 *
 * Renders NOTHING until there is history. A project that has never been migrated should not grow
 * an empty "Migrations" panel it will never fill — the card above it is the whole story then.
 */
export function ProjectMigrationHistory({
  projectId,
  onOpenRun,
}: {
  projectId: string;
  /** Open a run's session — the parent owns which run the tab is showing. */
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<MigrationRun[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});

  const fetchRuns = useCallback(async () => {
    try {
      const res = await dockerMigrationApi.listForProject(projectId);
      setRuns(res.runs);
    } catch {
      // History is context, never the point of the page: an unreachable list renders as "no
      // history" rather than an error the operator can do nothing about.
      setRuns((prev) => prev ?? []);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchRuns();
    void systemApi
      .listServers()
      .then((list) => {
        const map: Record<string, string> = {};
        for (const s of list) if (s.name) map[s.id] = s.name;
        setNames(map);
      })
      .catch(() => {});
  }, [fetchRuns]);

  // Poll only while something is actually moving, and only from this list — the run's own panel
  // has its own poll, so an open session is not paying for this one too.
  const anyInFlight = Boolean(runs?.some((r) => isRunInFlight(r.status)));
  useEffect(() => {
    if (!anyInFlight) return;
    const iv = setInterval(() => void fetchRuns(), 3500);
    return () => clearInterval(iv);
  }, [anyInFlight, fetchRuns]);

  if (!runs || runs.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t.migration.tab.detailTitle}
      </p>
      <MigrationRunList
        runs={runs}
        serverNames={names}
        viewpoint={{ kind: "project" }}
        onOpen={onOpenRun}
      />
    </div>
  );
}
