"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { isCreateDeploymentResult } from "@repo/contracts";
import type { RuntimeImageCheckResult, ApplySecurityInput } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { useToast } from "@/context/ToastContext";
import { getApiErrorMessage, getApiRequestScopeVersion, isAbortError } from "@/lib/api/client";
import { updatesApi } from "@/lib/api/updates";
import { useCloudDeployPricing } from "./useCloudDeployPricing";

/** One customer action for both image services and source builds. */
export function useRuntimeUpdate(
  projectId: string,
  serviceId?: string,
  workspaceId?: string | null,
  revision?: string | null,
) {
  const { t } = useI18n();
  const copy = t.projectSettings.runtimeUpdates;
  const { showToast } = useToast();
  const router = useRouter();
  const showCloudPricing = useCloudDeployPricing(workspaceId);
  const resourceKey = useCloudResourceKey();
  const identity = JSON.stringify([resourceKey, projectId, serviceId, revision]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const mounted = useRef(false);
  const pending = useRef<string | null>(null);
  const [pendingIdentity, setPendingIdentity] = useState<string | null>(null);
  const checking = useRef<string | null>(null);
  const [checkingIdentity, setCheckingIdentity] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<{
    identity: string;
    data: RuntimeImageCheckResult;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback(
    async function runUpdate(advisory?: ApplySecurityInput): Promise<void> {
      const scope = getApiRequestScopeVersion();
      const requestIdentity = `${identity}:${scope}`;
      if (pending.current === requestIdentity) return;
      // A billing recovery callback must never deploy in a newer account/project.
      if (!mounted.current || currentIdentity.current !== identity) return;
      const current = () =>
        mounted.current &&
        currentIdentity.current === identity &&
        getApiRequestScopeVersion() === scope;
      pending.current = requestIdentity;
      setPendingIdentity(requestIdentity);
      try {
        const { data } = advisory ? await updatesApi.applySecurity(projectId, advisory) : await updatesApi.updateRuntime(
          projectId,
          serviceId ? { serviceIds: [serviceId] } : {},
        );
        if (!current()) return;
        if (!isCreateDeploymentResult(data) || data.project_id !== projectId)
          throw new Error(copy.failed);
        router.push(
          data.awaiting_actions ? `/projects/${projectId}/actions` : `/build/${data.deployment_id}`,
        );
      } catch (error) {
        if (!current()) return;
        if (
          showCloudPricing(error, async () => {
            if (current()) await runUpdate(advisory);
          })
        )
          return;
        if (isAbortError(error)) {
          showToast(copy.uncertain, "info");
          router.push(`/projects/${projectId}/deployments`);
        } else {
          showToast(getApiErrorMessage(error, copy.failed), "error", copy.title);
        }
      } finally {
        if (pending.current === requestIdentity) pending.current = null;
        if (current()) setPendingIdentity(null);
      }
    },
    [
      identity,
      projectId,
      serviceId,
      copy.failed,
      copy.title,
      copy.uncertain,
      router,
      showCloudPricing,
      showToast,
    ],
  );

  const checkUpdates = useCallback(async () => {
    const scope = getApiRequestScopeVersion();
    const requestIdentity = `${identity}:${scope}`;
    if (!mounted.current || checking.current === requestIdentity) return;
    const current = () =>
      mounted.current &&
      currentIdentity.current === identity &&
      getApiRequestScopeVersion() === scope;
    checking.current = requestIdentity;
    setCheckingIdentity(requestIdentity);
    try {
      const { data } = await updatesApi.checkRuntime(
        projectId,
        serviceId ? { serviceIds: [serviceId] } : {},
      );
      if (!current()) return;
      setCheckResult({ identity: requestIdentity, data });
      const images = data.images;
      if (!images.some((image) => image.status === "update_available")) {
        showToast(
          images.length && images.every((image) => image.status === "pinned")
            ? copy.pinned
            : images.length &&
                images.every((image) => image.status === "current" || image.status === "pinned")
              ? copy.current
              : copy.checkUnavailable,
          "info",
        );
      }
    } catch (error) {
      if (current()) showToast(getApiErrorMessage(error, copy.checkFailed), "error");
    } finally {
      if (checking.current === requestIdentity) checking.current = null;
      if (current()) setCheckingIdentity(null);
    }
  }, [
    identity,
    projectId,
    serviceId,
    copy.pinned,
    copy.current,
    copy.checkUnavailable,
    copy.checkFailed,
    showToast,
  ]);

  return {
    update: () => update(),
    applyAdvisory: update,
    updating: pendingIdentity === `${identity}:${getApiRequestScopeVersion()}`,
    checkUpdates,
    checking: checkingIdentity === `${identity}:${getApiRequestScopeVersion()}`,
    checkResult:
      checkResult?.identity === `${identity}:${getApiRequestScopeVersion()}`
        ? checkResult.data
        : null,
  };
}
