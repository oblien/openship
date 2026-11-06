"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProjectSecurityResult } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { useToast } from "@/context/ToastContext";
import { useRuntimeUpdate } from "@/hooks/useRuntimeUpdate";
import { getApiErrorMessage, getApiRequestScopeVersion } from "@/lib/api/client";
import { updatesApi } from "@/lib/api/updates";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/Switch";
import Link from "next/link";
import { encodeProjectSlug } from "@/utils/repoSlug";
import { InvestigationLink } from "@/components/assistant/InvestigationLink";

type Finding = ProjectSecurityResult["findings"][number];
type ReviewGroup = {
  key: string;
  advisory: Pick<Finding, "id" | "revision" | "title" | "message" | "url" | "manualReviewRequired">;
  services: Finding[];
};

/** Share advisory copy only. Confidence, progress and actions belong to each service. */
function groupReviewFindings(findings: Finding[]) {
  const groups = new Map<string, ReviewGroup>();
  for (const finding of findings) {
    const key = JSON.stringify([
      finding.id,
      finding.revision,
      finding.manualReviewRequired ? "manual" : finding.serviceId,
    ]);
    const group = groups.get(key);
    if (group) group.services.push(finding);
    else groups.set(key, { key, advisory: finding, services: [finding] });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    possibleServices: group.services.filter((finding) => finding.confidence === "possible"),
  }));
}

/** One affected app inside the global advisory review; actions stay resource-scoped. */
export function SecurityProjectReview({
  projectId,
  serviceId,
  revision,
  workspaceId,
  name,
  initialResult,
  onChecked,
}: {
  projectId: string;
  name?: string;
  initialResult?: ProjectSecurityResult;
  onChecked?: () => void;
  serviceId?: string;
  revision?: string | null;
  workspaceId?: string | null;
}) {
  const { t } = useI18n();
  const copy = t.projectSettings.securityAdvisories;
  const { showToast } = useToast();
  const router = useRouter();
  const resourceKey = useCloudResourceKey();
  const identity = `${resourceKey}:${projectId}:${revision ?? ""}`;
  const latest = useRef(identity);
  latest.current = identity;
  const [state, setState] = useState<{ identity: string; data: ProjectSecurityResult } | null>(
    initialResult ? { identity, data: initialResult } : null,
  );
  const [policyBusy, setPolicyBusy] = useState(false);
  const [failedIdentity, setFailedIdentity] = useState<string | null>(null);
  const policyGeneration = useRef(0);
  const action = useRuntimeUpdate(projectId, serviceId, workspaceId, revision);
  const [checking, setChecking] = useState(false);
  const requestGeneration = useRef(0);
  const pendingCheck = useRef(false);
  useEffect(() => {
    if (initialResult) setState({ identity, data: initialResult });
  }, [identity, initialResult]);
  const check = useCallback(
    async (refresh = false) => {
      if (pendingCheck.current || (!refresh && document.visibilityState === "hidden")) return;
      pendingCheck.current = true;
      const request = ++requestGeneration.current;
      const policy = policyGeneration.current;
      const scope = getApiRequestScopeVersion();
      if (refresh) setChecking(true);
      try {
        const { data } = await (refresh
          ? updatesApi.checkSecurity(projectId)
          : updatesApi.security(projectId));
        if (
          request === requestGeneration.current &&
          scope === getApiRequestScopeVersion() &&
          latest.current === identity &&
          policy === policyGeneration.current
        ) {
          setState({ identity, data });
          setFailedIdentity(null);
          if (refresh) onChecked?.();
        }
      } catch (error) {
        if (
          request === requestGeneration.current &&
          scope === getApiRequestScopeVersion() &&
          latest.current === identity
        ) {
          setFailedIdentity(identity);
          if (refresh) showToast(getApiErrorMessage(error), "error");
        }
      } finally {
        if (request === requestGeneration.current) {
          pendingCheck.current = false;
          setChecking(false);
        }
      }
    },
    [identity, projectId, showToast, onChecked],
  );
  useEffect(() => {
    // The shared overview already polls. Do not add one request per app in Monitoring.
    if (initialResult) return;
    void check();
    const timer = setInterval(() => void check(), 5 * 60_000);
    return () => {
      requestGeneration.current++;
      pendingCheck.current = false;
      clearInterval(timer);
    };
  }, [check, initialResult]);
  const data = state?.identity === identity ? state.data : null;
  const unavailable =
    !data?.checkedAt || data.feedStale || !!data.feedError || failedIdentity === identity;
  const findings =
    data?.findings.filter((item) => !serviceId || item.serviceId === serviceId) ?? [];
  const changePolicy = async (value: boolean) => {
    policyGeneration.current++;
    const scope = getApiRequestScopeVersion();
    setPolicyBusy(true);
    try {
      const result = await updatesApi.securityPolicy(projectId, value);
      if (latest.current === identity && scope === getApiRequestScopeVersion()) {
        setState((previous) =>
          previous?.identity === identity
            ? { ...previous, data: { ...previous.data, autoRefresh: result.data.autoRefresh } }
            : previous,
        );
        onChecked?.();
      }
    } catch (error) {
      if (latest.current === identity && scope === getApiRequestScopeVersion())
        showToast(getApiErrorMessage(error), "error");
    } finally {
      setPolicyBusy(false);
    }
  };
  return (
    <details className="rounded-2xl bg-card p-4" open={findings.length > 0 ? true : undefined}>
      <summary className="cursor-pointer text-sm font-medium text-foreground">
        {name ?? copy.title}
        {findings.length > 0 && <span className="ms-2 text-warning">{findings.length}</span>}
      </summary>
      <div className="mt-4 space-y-4">
        {(unavailable || !findings.length) && (
          <p className="text-sm text-muted-foreground">
            {unavailable ? copy.unavailable : copy.noMatches}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {data?.checkedAt && (
            <p className="text-xs text-muted-foreground">
              {copy.checked}:{" "}
              <time dateTime={data.checkedAt}>{new Date(data.checkedAt).toLocaleString()}</time>
            </p>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={checking || action.updating}
            onClick={() => void check(true)}
          >
            {checking ? copy.checking : copy.checkAgain}
          </Button>
        </div>
        {!!data?.unknownServices.length && (
          <p className="text-xs text-muted-foreground">{copy.partial}</p>
        )}
        {groupReviewFindings(findings).map(({ key, advisory, services, possibleServices }) => (
          <div key={key} className="space-y-2 rounded-xl bg-card p-4">
            <p className="text-sm font-medium">{advisory.title}</p>
            {!serviceId && services.some((item) => item.serviceName) && (
              <p className="break-words text-xs text-muted-foreground">
                {services
                  .map((item) => item.serviceName)
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            {possibleServices.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {possibleServices.length < services.length && (
                  <span className="font-medium">
                    {possibleServices
                      .map((item) => item.serviceName || item.serviceId)
                      .filter(Boolean)
                      .join(" · ")}
                    {": "}
                  </span>
                )}
                {advisory.manualReviewRequired ? copy.manualReviewUnverified : copy.possible}
              </p>
            )}
            {[...new Set(services.flatMap((item) => item.evidence))].map((evidence) => (
              <p key={evidence} className="break-all font-mono text-xs text-muted-foreground">
                {evidence}
              </p>
            ))}
            {services.map(
              (finding) =>
                (finding.refresh || finding.refreshBlockedReason) && (
                  <div key={JSON.stringify(finding.serviceId)} className="space-y-1">
                    {services.length > 1 && (finding.serviceName || finding.serviceId) && (
                      <p className="text-xs font-medium text-muted-foreground">
                        {finding.serviceName || finding.serviceId}
                      </p>
                    )}
                    {finding.refresh && (
                      <div role="status" className="space-y-1 text-sm">
                        <p
                          className={
                            finding.refresh.status === "failed"
                              ? "text-warning"
                              : "text-muted-foreground"
                          }
                        >
                          {finding.refresh.status === "failed"
                            ? (finding.refresh.error ?? copy.refreshFailed)
                            : finding.refresh.status === "awaiting_actions"
                              ? copy.refreshAwaitingActions
                              : copy.refreshInProgress}
                        </p>
                        {finding.refresh.deploymentId && (
                          <Link
                            className="underline underline-offset-4"
                            href={`/build/${finding.refresh.deploymentId}`}
                          >
                            {copy.viewRefresh}
                          </Link>
                        )}
                      </div>
                    )}
                    {finding.refreshBlockedReason && (
                      <p className="text-sm text-warning">
                        {finding.sourceRedeployRequired
                          ? copy.sourceRedeployRequired
                          : finding.refreshBlockedReason}
                      </p>
                    )}
                  </div>
                ),
            )}
            {advisory.manualReviewRequired ? (
              <div className="space-y-2 text-sm">
                <p className="font-medium text-warning">{copy.manualReviewRequired}</p>
                <p className="text-muted-foreground">{copy.manualReviewDescription}</p>
                <p className="whitespace-pre-line leading-relaxed text-muted-foreground">
                  {advisory.message}
                </p>
              </div>
            ) : (
              <details
                className="text-sm text-muted-foreground"
                open={services.some((item) => item.runtimeUpgradeRequired)}
              >
                <summary className="cursor-pointer">{copy.details}</summary>
                <p className="mt-2 leading-relaxed">{advisory.message}</p>
              </details>
            )}
            <div className="flex flex-wrap items-center gap-3">
              {advisory.manualReviewRequired && (
                <InvestigationLink
                  target={{ kind: "security", projectId, advisoryId: advisory.id }}
                  size="sm"
                />
              )}
              <a
                className="text-sm underline underline-offset-4"
                href={advisory.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {copy.guidance}
              </a>
              {services.map(
                (finding) =>
                  finding.canRefresh &&
                  data?.deploymentId && (
                    <Button
                      key={JSON.stringify(finding.serviceId)}
                      size="sm"
                      disabled={action.updating || unavailable}
                      onClick={() =>
                        void action.applyAdvisory({
                          advisoryId: advisory.id,
                          deploymentId: data.deploymentId!,
                          serviceId: finding.serviceId,
                        })
                      }
                    >
                      {action.updating
                        ? t.projectSettings.runtimeUpdates.refreshing
                        : t.projectSettings.runtimeUpdates.refresh}
                    </Button>
                  ),
              )}
              {services.some((item) => item.sourceRedeployRequired) && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    router.push(`/projects/${encodeURIComponent(projectId)}/deployments`)
                  }
                >
                  {copy.openSourceRedeploy}
                </Button>
              )}
              {(advisory.manualReviewRequired ||
                services.some(
                  (item) => item.runtimeUpgradeRequired || item.imageChangeRequired,
                )) && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    router.push(
                      `/deploy/${encodeProjectSlug(projectId)}?${new URLSearchParams({ projectId, mode: "config" })}`,
                    )
                  }
                >
                  {copy.openRuntimeConfiguration}
                </Button>
              )}
            </div>
          </div>
        ))}
        {!serviceId && (
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {copy.automatic}
            </summary>
            <div className="mt-3 flex items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="max-w-2xl text-xs text-muted-foreground">
                  {copy.automaticDescription}
                </p>
              </div>
              <Switch
                checked={data?.autoRefresh ?? false}
                disabled={!data || policyBusy}
                ariaLabel={copy.automatic}
                onChange={(value) => void changePolicy(value)}
              />
            </div>
          </details>
        )}
      </div>
    </details>
  );
}
