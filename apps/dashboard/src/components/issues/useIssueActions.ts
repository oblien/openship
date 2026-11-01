"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isCreateDeploymentResult, isRecord } from "@repo/contracts";

import {
  getActiveOrganizationId,
  getApiErrorMessage,
  subscribeActiveOrganization,
} from "@/lib/api/client";
import { deployApi } from "@/lib/api/deploy";
import {
  issueDeploymentId,
  issueUpdateInProgress,
  runResolution,
  type SystemIssue,
} from "@/lib/api/issues";
import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/components/toast";
import { useInfraFix } from "@/hooks/useInfraFix";
import type { SystemPreparePresenter } from "@/hooks/useSystemPrepareModal";

const EMPTY_ISSUES: readonly SystemIssue[] = [];
interface PendingResolution {
  issue: SystemIssue;
  organizationId: string | null;
  deploymentId?: string;
  notified?: boolean;
}

/** One resolution flow for Home and Monitoring; queued deployments finish asynchronously. */
export function useIssueActions(
  reload: (opts?: { silent?: boolean }) => void | Promise<void>,
  present?: SystemPreparePresenter,
  issues: readonly SystemIssue[] = EMPTY_ISSUES,
) {
  const { t } = useI18n();
  const c = t.issues.toast;
  const { toast } = useToast();
  const openInfraFix = useInfraFix(present);
  const organizationId = useSyncExternalStore(
    subscribeActiveOrganization,
    getActiveOrganizationId,
    () => null,
  );
  const [pending, setPending] = useState<PendingResolution[]>([]);
  // State alone does not guard two clicks before React commits the first one.
  const pendingRef = useRef(new Map<string, PendingResolution>());
  const owner = useRef({ active: false });
  const latest = useRef({ reload, toast, c });
  latest.current = { reload, toast, c };

  useEffect(() => {
    const current = { active: true };
    owner.current = current;
    return () => {
      current.active = false;
    };
  }, [organizationId]);

  useEffect(() => {
    if (
      [...pendingRef.current.values()].some((action) => action.organizationId !== organizationId)
    ) {
      pendingRef.current.clear();
      setPending([]);
    }
  }, [organizationId]);

  // Keep the scope that produced these rows until the caller supplies a new
  // feed. Switching workspaces cannot reattach old deployment IDs in the new org.
  const feedRuns = useMemo(
    () => ({
      organizationId: getActiveOrganizationId(),
      ids: issues.flatMap((issue) => {
        const id = issueDeploymentId(issue);
        return id ? [id] : [];
      }),
    }),
    [issues],
  );
  const runKey = JSON.stringify(
    [
      ...new Set([
        ...(feedRuns.organizationId === organizationId ? feedRuns.ids : []),
        ...pending.flatMap((action) =>
          action.organizationId === organizationId && action.deploymentId
            ? [action.deploymentId]
            : [],
        ),
      ]),
    ].sort(),
  );

  useEffect(() => {
    const ids: string[] = JSON.parse(runKey);
    if (!ids.length) return;
    const controller = new AbortController();
    const current = () =>
      !controller.signal.aborted && organizationId === getActiveOrganizationId();
    const completed = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let failures = 0;
    const poll = async () => {
      if (!current() || reading) return;
      clearTimeout(timer);
      if (document.visibilityState === "hidden" || navigator.onLine === false) {
        timer = setTimeout(() => void poll(), 5_000);
        return;
      }
      reading = true;
      let failed = false;
      try {
        await Promise.all(
          ids.map(async (id) => {
            if (completed.has(id)) return;
            try {
              // Read persisted status only: no source scan, registry request,
              // build start, or automatic retry of the mutation.
              const response = await deployApi.getBuildStatus(id, {
                signal: controller.signal,
                dedupe: false,
                headers: organizationId ? { "X-Organization-Id": organizationId } : {},
              });
              if (!current()) return;
              const status = response?.data ?? response;
              if (
                !status ||
                !["ready", "failed", "cancelled"].includes(status.status) ||
                status.deploymentStatus === "reconciling" ||
                status.completionPending ||
                status.cancellationPending
              )
                return;
              completed.add(id);
              const action = [...pendingRef.current.values()].find(
                (action) => action.deploymentId === id,
              );
              if (
                action?.deploymentId === id &&
                action.organizationId === organizationId &&
                !action.notified
              ) {
                action.notified = true;
                const { toast, c } = latest.current;
                const success = ["ready", "no_changes"].includes(status.deploymentStatus);
                toast(
                  success ? "success" : "error",
                  success
                    ? c.resolved
                    : status.errorMessage || status.warningMessage || c.resolveFailed,
                  c.title,
                );
              }
            } catch (diagnosticFailure) {
              observeCaughtError(diagnosticFailure, "dashboard/components/issues/useIssueActions");
              // A failed read says nothing about the deployment's outcome.
              failed = true;
            }
          }),
        );
        if (current() && completed.size) {
          await latest.current.reload({ silent: true });
          if (current()) {
            let changed = false;
            for (const [key, action] of pendingRef.current) {
              if (action.deploymentId && completed.has(action.deploymentId)) {
                pendingRef.current.delete(key);
                changed = true;
              }
            }
            if (changed) setPending([...pendingRef.current.values()]);
          }
        }
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/components/issues/useIssueActions");
        failed = true;
      } finally {
        reading = false;
        if (current()) {
          failures = failed ? failures + 1 : 0;
          timer = setTimeout(
            () => void poll(),
            Math.min(5_000 * 2 ** Math.min(failures, 3), 30_000),
          );
        }
      }
    };
    const resume = () => {
      void poll();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [runKey, organizationId]);

  const resolve = useCallback(
    async (issue: SystemIssue) => {
      const fix = issue.resolveWith[0];
      if (
        !fix ||
        pendingRef.current.has(issue.id) ||
        issueUpdateInProgress(issue) ||
        organizationId !== getActiveOrganizationId() ||
        (issues !== EMPTY_ISSUES && feedRuns.organizationId !== organizationId)
      )
        return;
      if (fix.destructive && !window.confirm(c.confirmDestructive)) return;
      const mounted = owner.current;
      const current = () => mounted.active && organizationId === getActiveOrganizationId();
      const action: PendingResolution = { issue, organizationId };
      pendingRef.current.set(issue.id, action);
      setPending([...pendingRef.current.values()]);
      try {
        const response = await runResolution(fix);
        if (!current()) return;
        const result = isRecord(response) && isRecord(response.data) ? response.data : response;
        if (isCreateDeploymentResult(result)) {
          action.deploymentId = result.deployment_id;
          setPending([...pendingRef.current.values()]);
          return;
        }
        toast("success", c.resolved, c.title);
        await Promise.resolve()
          .then(() => reload({ silent: true }))
          .catch((diagnosticFailure) => {
            observeCaughtError(diagnosticFailure, "dashboard/components/issues/useIssueActions");
          });
      } catch (err) {
        if (current()) {
          toast("error", getApiErrorMessage(err, c.resolveFailed), c.title);
          await Promise.resolve()
            .then(() => reload({ silent: true }))
            .catch((diagnosticFailure) => {
              observeCaughtError(diagnosticFailure, "dashboard/components/issues/useIssueActions");
            });
        }
      } finally {
        if (current() && pendingRef.current.get(issue.id) === action && !action.deploymentId) {
          pendingRef.current.delete(issue.id);
          setPending([...pendingRef.current.values()]);
        }
      }
    },
    [organizationId, c, toast, reload, issues, feedRuns.organizationId],
  );

  /**
   * Managed containers fix through a streamed modal, not an HTTP call — the flow can
   * need consent (port takeover) and its log is the only useful failure report.
   */
  const infraFix = useCallback(
    (issue: SystemIssue) => {
      if (!issue.infraFix) return;
      openInfraFix(
        { ...issue.infraFix, label: issue.title },
        { onDone: () => void reload({ silent: true }) },
      );
    },
    [openInfraFix, reload],
  );

  const visibleIssues = useMemo(() => {
    const rows = [...issues];
    // An older/partial feed response cannot make a just-accepted update vanish.
    // Its deployment status, rather than absence from a feed, ends this overlay.
    for (const action of pending) {
      if (!action.deploymentId || action.organizationId !== organizationId) continue;
      const row = {
        ...action.issue,
        details: { ...action.issue.details, inProgressDeploymentId: action.deploymentId },
        target: { ...action.issue.target, href: `/build/${action.deploymentId}` },
      };
      const index = rows.findIndex((issue) => issue.id === row.id);
      if (index < 0) rows.push(row);
      else rows[index] = row;
    }
    return rows;
  }, [issues, pending, organizationId]);

  return {
    busyIds: new Set(
      pending
        .filter((action) => action.organizationId === organizationId)
        .map((action) => action.issue.id),
    ),
    resolve,
    infraFix,
    issues: visibleIssues,
  };
}
