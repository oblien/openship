import React from "react";
import { Globe, Plus, Trash2 } from "lucide-react";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";
import type { PublicEndpoint } from "@/context/deployment/types";
import { createPublicEndpoint } from "@/context/deployment/types";

interface PublicEndpointsCardProps {
  projectName: string;
  endpoints: PublicEndpoint[];
  hasServer: boolean;
  runtimePort: string;
  allowPortEdit?: boolean;
  onChange: (endpoints: PublicEndpoint[], runtimePort?: string) => void;
  saveMode?: "change" | "explicit";
}

const PublicEndpointsCard: React.FC<PublicEndpointsCardProps> = ({
  projectName,
  endpoints,
  hasServer,
  runtimePort,
  allowPortEdit = true,
  onChange,
  saveMode = "change",
}) => {
  const hasMultipleEndpoints = endpoints.length > 1;

  const normalizeEndpointForMode = (
    endpoint: PublicEndpoint,
    linkedRuntimePort = runtimePort,
  ): PublicEndpoint => (
    hasServer
      ? {
          ...endpoint,
          port: endpoint.port || linkedRuntimePort || "",
          targetPath: "",
        }
      : {
          ...endpoint,
          port: "",
          targetPath: endpoint.targetPath || "/",
        }
  );

  const commitEndpoints = (nextEndpoints: PublicEndpoint[], nextRuntimePort = runtimePort) => {
    onChange(nextEndpoints, hasServer ? nextRuntimePort : undefined);
  };

  const handleEndpointChange = (
    endpointId: string,
    updates: Partial<PublicEndpoint>,
  ) => {
    const isPrimaryEndpoint = endpoints[0]?.id === endpointId;
    const nextRuntimePort = hasServer && isPrimaryEndpoint && typeof updates.port === "string"
      ? (updates.port || runtimePort)
      : runtimePort;

    commitEndpoints(
      endpoints.map((endpoint) => (
        endpoint.id === endpointId
          ? normalizeEndpointForMode({ ...endpoint, ...updates }, nextRuntimePort)
          : endpoint
      )),
      nextRuntimePort,
    );
  };

  const handleAddEndpoint = () => {
    const lastEndpoint = endpoints[endpoints.length - 1];
    commitEndpoints([
      ...endpoints,
      normalizeEndpointForMode(createPublicEndpoint(
        hasServer
          ? {
              port: lastEndpoint?.port || runtimePort || "",
            }
          : {
              targetPath: lastEndpoint?.targetPath || "/",
            },
      )),
    ]);
  };

  const handleRemoveEndpoint = (endpointId: string) => {
    if (endpoints.length <= 1) {
      return;
    }

    const nextEndpoints = endpoints.filter((endpoint) => endpoint.id !== endpointId);
    const nextRuntimePort = hasServer && endpoints[0]?.id === endpointId
      ? (nextEndpoints[0]?.port || runtimePort || "")
      : runtimePort;

    commitEndpoints(nextEndpoints, nextRuntimePort);
  };

  const describeEndpointTarget = (endpoint: PublicEndpoint) => {
    if (hasServer) {
      const mappedPort = endpoint.port || runtimePort || "";
      return mappedPort ? `Mapped to port ${mappedPort}.` : "No port selected yet.";
    }

    return `Mapped to ${endpoint.targetPath || "/"}.`;
  };

  const renderRoutingCard = (endpoint: PublicEndpoint) => {
    const resolvedUrl = endpoint.domainType === "custom" && endpoint.customDomain
      ? `https://${endpoint.customDomain}`
      : null;
    const readOnlyTarget = !allowPortEdit
      ? {
          label: hasServer ? "Exposed port" : "Static path",
          value: hasServer ? (endpoint.port || runtimePort || "Auto") : (endpoint.targetPath || "/"),
          icon: hasServer ? ("port" as const) : ("path" as const),
        }
      : undefined;

    return (
      <RoutingSettingsCard
        projectName={projectName}
        domain={endpoint.domain}
        customDomain={endpoint.customDomain}
        domainType={endpoint.domainType}
        targetMode={hasServer ? "proxy" : "static"}
        targetPath={hasServer ? undefined : endpoint.targetPath}
        exposedPort={hasServer ? endpoint.port : undefined}
        readOnlyTarget={readOnlyTarget}
        liveUrl={resolvedUrl}
        onDomainChange={(value) => handleEndpointChange(endpoint.id, { domain: value })}
        onCustomDomainChange={(value) => handleEndpointChange(endpoint.id, { customDomain: value })}
        onDomainTypeChange={(value) => handleEndpointChange(endpoint.id, { domainType: value })}
        onExposedPortChange={hasServer && allowPortEdit
          ? (value) => handleEndpointChange(endpoint.id, { port: value })
          : undefined}
        onTargetPathChange={!hasServer && allowPortEdit
          ? (value) => handleEndpointChange(endpoint.id, { targetPath: value })
          : undefined}
        saveMode={saveMode}
      />
    );
  };

  if (endpoints.length === 0) {
    return null;
  }

  return (
    <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/40">
        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
          <Globe className="size-3.5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground leading-tight">Domain</h3>
          <p className="text-[11px] text-muted-foreground">
            {hasMultipleEndpoints
              ? `${endpoints.length} domains routed to this app.`
              : "Where your site will be accessible"}
          </p>
        </div>
        <button
          type="button"
          onClick={handleAddEndpoint}
          className="inline-flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          aria-label="Add domain"
          title="Add domain"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {hasMultipleEndpoints ? endpoints.map((endpoint, index) => (
          <div key={endpoint.id} className="rounded-xl border border-border/50 bg-background/50 overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border/40">
              <div>
                <h4 className="text-sm font-semibold text-foreground leading-tight">
                  {index === 0 ? "Primary domain" : `Domain ${index + 1}`}
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  {describeEndpointTarget(endpoint)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleRemoveEndpoint(endpoint.id)}
                disabled={endpoints.length <= 1}
                className="inline-flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Trash2 className="size-3.5" />
                Remove
              </button>
            </div>

            <div className="p-4">
              {renderRoutingCard(endpoint)}
            </div>
          </div>
        )) : renderRoutingCard(endpoints[0])}
      </div>
    </div>
  );
};

export default PublicEndpointsCard;