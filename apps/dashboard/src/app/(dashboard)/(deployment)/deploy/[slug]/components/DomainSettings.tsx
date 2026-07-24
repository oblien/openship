"use client";

import React, { useCallback } from "react";
import { getApiErrorMessage, projectsApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { RoutingModePicker, type RoutingMode } from "@/components/routing/RoutingModePicker";
import { createPublicEndpoint, type PublicEndpoint } from "@/context/deployment/types";

interface DomainSettingsProps {
  projectId?: string;
  projectName: string;
  endpoints: PublicEndpoint[];
  hasServer: boolean;
  runtimePort: string;
  setEndpoints: (endpoints: PublicEndpoint[], runtimePort?: string) => void;
  /** "None" routing — deploy with no public URL. */
  noPublicRoute: boolean;
  setNoPublicRoute: (value: boolean) => void;
}

function buildPublicEndpointPayload(
  endpoint: PublicEndpoint,
  hasServer: boolean,
): {
  port?: number;
  targetPath?: string;
  domain?: string;
  customDomain?: string;
  domainType: "free" | "custom";
} | null {
  const domainType: "free" | "custom" = endpoint.domainType === "custom" ? "custom" : "free";
  const freeDomain = endpoint.domain.trim().toLowerCase();
  const customDomain = endpoint.customDomain.trim().toLowerCase();

  if (domainType === "custom" && !customDomain) {
    return null;
  }

  if (domainType === "free" && !freeDomain) {
    return null;
  }

  if (hasServer) {
    const port = Number(endpoint.port.trim());
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return null;
    }

    return {
      port,
      domainType,
      ...(domainType === "custom" ? { customDomain } : { domain: freeDomain }),
    };
  }

  return {
    targetPath: endpoint.targetPath.trim() || "/",
    domainType,
    ...(domainType === "custom" ? { customDomain } : { domain: freeDomain }),
  };
}

const DomainSettings: React.FC<DomainSettingsProps> = ({
  projectId,
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
  const { baseDomain } = usePlatform();

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

    const primaryPort = hasServer && "port" in payload[0] ? payload[0].port : undefined;

    try {
      await projectsApi.update(projectId, {
        publicEndpoints: payload,
        ...(typeof primaryPort === "number" ? { port: primaryPort } : {}),
      });
    } catch (error) {
      console.error("Failed to persist deploy domains:", error);
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
        return;
      }
      setNoPublicRoute(false);
      // Free/Custom set the (first) endpoint's domainType — seed one if the set
      // was emptied. The inner card's own type toggle is hidden, so this is the
      // single source of the free-vs-custom choice.
      const base = endpoints[0] ?? createPublicEndpoint({ domainType: next });
      void handleChange([{ ...base, domainType: next }, ...endpoints.slice(1)]);
    },
    [endpoints, handleChange, setNoPublicRoute],
  );

  return (
    <RoutingModePicker
      mode={mode}
      onModeChange={handleModeChange}
      labels={{
        freeLabel: t.deploy.domainSettings.routeFreeLabel,
        freeDesc: interpolate(t.deploy.domainSettings.routeFreeDesc, { domain: baseDomain }),
        customLabel: t.deploy.domainSettings.routeCustomLabel,
        customDesc: t.deploy.domainSettings.routeCustomDesc,
        noneLabel: t.deploy.domainSettings.routeNoneLabel,
        noneDesc: t.deploy.domainSettings.routeNoneDesc,
      }}
      projectName={projectName}
      endpoints={endpoints}
      hasServer={hasServer}
      runtimePort={runtimePort}
      onEndpointsChange={handleChange}
    />
  );
};

export default DomainSettings;
