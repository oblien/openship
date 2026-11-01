"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useState } from "react";
import { getActiveOrganizationId } from "@/lib/api/client";
import { issuesApi, subscribeOpenIssueCounts, type IssueCounts } from "@/lib/api/issues";

const POLL_MS = 30_000;

/** Undefined waits for workspace selection; null uses the session's default workspace. */
export function useIssueCounts(organizationId: string | null | undefined): IssueCounts | null {
  const [snapshot, setSnapshot] = useState<{
    organizationId: string | null;
    counts: IssueCounts;
  } | null>(null);

  useEffect(() => {
    if (organizationId === undefined) return;
    let cancelled = false;
    let reading = false;
    let feedRevision = 0;
    setSnapshot(null);

    const unsubscribe = subscribeOpenIssueCounts((counts, scope) => {
      if (scope !== organizationId) return;
      feedRevision += 1;
      setSnapshot({ organizationId, counts });
    });

    const refresh = async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      const revision = feedRevision;
      try {
        const result = await issuesApi.summary();
        // A feed refresh after a repair is newer than a summary already in flight.
        if (
          !cancelled &&
          revision === feedRevision &&
          organizationId === getActiveOrganizationId()
        ) {
          setSnapshot({ organizationId, counts: result.data });
        }
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/hooks/useIssueCounts");
        // Keep the last known count until the next successful read.
      } finally {
        reading = false;
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), POLL_MS);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [organizationId]);

  return organizationId !== undefined && snapshot?.organizationId === organizationId
    ? snapshot.counts
    : null;
}
