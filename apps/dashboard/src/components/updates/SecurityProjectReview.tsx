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
        {findings.map((finding) => (
          <div
            key={`${finding.id}:${finding.serviceId}`}
            className="space-y-2 rounded-xl bg-card p-4"
          >
            <p className="text-sm font-medium">{finding.title}</p>
            {!serviceId && finding.serviceName && (
              <p className="text-xs text-muted-foreground">{finding.serviceName}</p>
            )}
            {finding.confidence === "possible" && (
              <p className="text-xs text-warning">{copy.possible}</p>
            )}
            {finding.evidence.map((evidence) => (
              <p key={evidence} className="break-all font-mono text-xs text-muted-foreground">
                {evidence}
              </p>
            ))}
            {finding.refreshBlockedReason && (
              <p className="text-sm text-warning">
                {finding.sourceRedeployRequired
                  ? copy.sourceRedeployRequired
                  : finding.refreshBlockedReason}
              </p>
            )}
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">{copy.details}</summary>
              <p className="mt-2 leading-relaxed">{finding.message}</p>
            </details>
            <div className="flex flex-wrap items-center gap-3">
              <a
                className="text-sm underline underline-offset-4"
                href={finding.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {copy.guidance}
              </a>
              {finding.canRefresh && data?.deploymentId && (
                <Button
                  size="sm"
                  disabled={action.updating || unavailable}
                  onClick={() =>
                    void action.applyAdvisory({
                      advisoryId: finding.id,
                      deploymentId: data.deploymentId!,
                      serviceId: finding.serviceId,
                    })
                  }
                >
                  {action.updating
                    ? t.projectSettings.runtimeUpdates.refreshing
                    : t.projectSettings.runtimeUpdates.refresh}
                </Button>
              )}
              {finding.sourceRedeployRequired && (
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
