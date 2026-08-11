"use client";

/**
 * "Free domain routing needs attention" + Retry — the release is live on the
 * server, but the routes in front of it didn't sync.
 *
 * It lives on Domains & Routes rather than Deployments because nothing is wrong
 * with the release: it built, shipped and is running. What's wrong is the route,
 * so the banner belongs beside the routes it's about — next to the per-domain
 * state (verification, SSL, target) an operator reads in the same breath, and
 * next to the controls that actually change any of it.
 *
 * One component rather than a copy per tab: the retry is a real repair with its
 * own failure copy (`retryProjectRouting` re-points the deployment's server
 * binding, restores nulled custom-domain ports, re-applies the live routes, and
 * verifies the edge is SERVING them), and two renderings would drift the moment
 * one of them learned something the other didn't.
 */

import React from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { getApiErrorMessage, projectsApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import WarningCallout from "@/components/shared/WarningCallout";

export const RoutingUnsyncedCallout = () => {
  const { projectData, updateProjectData } = useProjectSettings();
  const { t } = useI18n();
  const { showToast } = useToast();
  const [isRetrying, setIsRetrying] = React.useState(false);

  /** Re-run the routing repair (no rebuild). On success the warning clears and the
   *  project flips back to Live; on failure the server's own reason is surfaced —
   *  it names the thing to fix (an edge not serving :80, an unreachable box). */
  const handleRetry = async () => {
    if (!projectData?.id || isRetrying) return;
    setIsRetrying(true);
    try {
      const res = await projectsApi.retryRouting(projectData.id);
      if (res?.ok) {
        updateProjectData({ routingUnsynced: false });
        showToast(t.projects.routingRetry.success, "success", t.projects.routingRetry.title);
      } else {
        showToast(
          res?.warning || res?.error || t.projects.routingRetry.failed,
          "error",
          t.projects.routingRetry.title,
        );
      }
    } catch (err) {
      showToast(
        getApiErrorMessage(err) || t.projects.routingRetry.failed,
        "error",
        t.projects.routingRetry.title,
      );
    } finally {
      setIsRetrying(false);
    }
  };

  // A pending partial-failure decision outranks this: that release hasn't been
  // accepted yet, so its routes aren't the thing to fix first.
  if (!projectData?.routingUnsynced || projectData.awaitingDecision) return null;

  return (
    <WarningCallout
      title={t.projects.routingRetry.title}
      description={t.projects.routingRetry.description}
      actions={
        <button
          type="button"
          onClick={handleRetry}
          disabled={isRetrying}
          className="rounded-lg bg-warning-solid px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-warning-solid/90 disabled:opacity-60"
        >
          {isRetrying ? t.projects.routingRetry.retrying : t.projects.routingRetry.retry}
        </button>
      }
    />
  );
};

export default RoutingUnsyncedCallout;
