"use client";

import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { IngressDestinationNotice } from "@/components/ingress/DomainIngressSettings";
import React, { useCallback } from "react";
import { isValidCustomHostname, withKeyedMutex } from "@repo/core";
import { getApiErrorMessage, projectsApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import { RoutingModePicker, type RoutingMode } from "@/components/routing/RoutingModePicker";
import { createPublicEndpoint, type PublicEndpoint } from "@/context/deployment/types";
import { validatedPublicEndpointPayload } from "@/lib/public-endpoint-payload";
import { normalizeSubdomain } from "@/utils/subdomain";
import { getApiRequestScopeVersion } from "@/lib/api/client";

interface DomainSettingsProps {
  projectId?: string;
  serverId?: string;
  projectName: string;
  endpoints: PublicEndpoint[];
  hasServer: boolean;
  runtimePort: string;
  setEndpoints: (endpoints: PublicEndpoint[], runtimePort?: string) => void;
  /** "None" routing — deploy with no public URL. */
  noPublicRoute: boolean;
  setNoPublicRoute: (value: boolean) => void;
}

/** Shared with the project Domains tab — see lib/public-endpoint-payload. */
const buildPublicEndpointPayload = validatedPublicEndpointPayload;

function saveDomains(projectId: string, fields: Record<string, unknown>) {
  const scope = getApiRequestScopeVersion();
  return withKeyedMutex(`deploy-domain-save:${scope}:${projectId}`, async () => {
    if (scope !== getApiRequestScopeVersion()) return;
    return projectsApi.update(projectId, fields);
  });
}

const DomainSettings: React.FC<DomainSettingsProps> = ({
  projectId,
  serverId,
  projectName,
  endpoints,
  hasServer,
  runtimePort,
  setEndpoints,
  noPublicRoute,
  setNoPublicRoute,
}) => {
  const { showToast } = useToast();
  const { t } = useI18n();

  const handleChange = useCallback(async (
    nextEndpoints: PublicEndpoint[],
    nextRuntimePort?: string,
  ) => {
    setEndpoints(nextEndpoints, nextRuntimePort);

    if (!projectId) {
      return;
    }

    const payload = nextEndpoints
      .map((endpoint) => buildPublicEndpointPayload(endpoint, hasServer))
      .filter((endpoint): endpoint is NonNullable<ReturnType<typeof buildPublicEndpointPayload>> => endpoint !== null);

    if (payload.length !== nextEndpoints.length || payload.length === 0) {
      return;
    }

    // This card autosaves on every KEYSTROKE (saveMode="change"), so a custom
    // domain would be submitted once per character — and the API rejects a
    // half-typed hostname, which would put a red toast on screen for "a", "ap",
    // "app.", … before the real save succeeded. Wait until the hostname is a
    // plausible one; the keystroke that completes it saves normally. An invalid
    // FINAL value is still reported — by the deploy request, which sends the
    // endpoints itself and surfaces the API's precise message.
    if (
      payload.some(
        (endpoint) =>
          endpoint.domainType === "custom" && !isValidCustomHostname(endpoint.customDomain ?? ""),
      )
    ) {
      return;
    }

    const primaryPort = hasServer ? payload.find((endpoint) => !endpoint.redirectTo)?.port : undefined;

    try {
      await saveDomains(projectId, {
        publicEndpoints: payload,
        ...(typeof primaryPort === "number" ? { port: primaryPort } : {}),
      });
    } catch (error) {
      errorDiagnostics.error("dashboard/app/(dashboard)/(deployment)/deploy/[slug]/components/DomainSettings", "Failed to persist deploy domains:", error);
      showToast(getApiErrorMessage(error, t.deploy.domainSettings.saveFailed), "error", t.deploy.domainSettings.toastTitle);
    }
  }, [hasServer, projectId, setEndpoints, showToast]);

  const mode: RoutingMode = noPublicRoute
    ? "none"
    : endpoints[0]?.domainType === "custom"
      ? "custom"
      : "free";

  const handleModeChange = useCallback(
    (next: RoutingMode) => {
      if (next === "none") {
        setNoPublicRoute(true);
        // Picking None is a REMOVAL, not just a flag. Clear the endpoint set and
        // persist `publicEndpoints: []` right away:
        //   - the wizard has ONE source of truth again, so nothing downstream
        //     (deploy summary, cloud gate) can keep reading a domain the user
        //     just turned off — the summary went on showing `<slug>.opsh.io`
        //     because it read the endpoints and never checked this flag;
        //   - the project record stops carrying a domain the user didn't ask
        //     for, even if they abandon the wizard here. An explicit [] makes
        //     the API drop the domain rows and deregister the live route
        //     (undefined would make it auto-derive the free subdomain again).
        setEndpoints([]);
        if (projectId) {
          void saveDomains(projectId, { publicEndpoints: [] }).catch((error) => {
            showToast(
              getApiErrorMessage(error, t.deploy.domainSettings.saveFailed),
              "error",
              t.deploy.domainSettings.toastTitle,
            );
          });
        }
        return;
      }
      setNoPublicRoute(false);
      // Free/Custom set the (first) endpoint's domainType — seed one if the set
      // was emptied (by None, above). The inner card's own type toggle is hidden,
      // so this is the single source of the free-vs-custom choice. A fresh free
      // endpoint takes the project's own subdomain label, so coming back from
      // None lands on the same URL it would have had, not a blank field (the
      // card only shows the project name as a PLACEHOLDER, which persists as an
      // empty domain and silently saves nothing).
      const base =
        endpoints[0] ??
        createPublicEndpoint({
          domainType: next,
          domain: next === "free" ? normalizeSubdomain(projectName) : "",
        });
      void handleChange([{ ...base, domainType: next }, ...endpoints.slice(1)]);
    },
    [endpoints, handleChange, projectId, projectName, setEndpoints, setNoPublicRoute, showToast, t],
  );

  return (
    <div className="space-y-3">{mode === "custom" && <IngressDestinationNotice serverId={serverId} />}<RoutingModePicker
      mode={mode}
      onModeChange={handleModeChange}
      labels={{
        noneLabel: t.deploy.domainSettings.routeNoneLabel,
        noneDesc: t.deploy.domainSettings.routeNoneDesc,
      }}
      projectName={projectName}
      endpoints={endpoints}
      hasServer={hasServer}
      runtimePort={runtimePort}
      onEndpointsChange={handleChange}
      allowRedirects
    /></div>
  );
};

export default DomainSettings;
