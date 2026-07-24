"use client";

import React, { useState } from "react";
import { ChevronDown, Globe, Plus, Trash2 } from "lucide-react";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";
import { useI18n, interpolate } from "@/components/i18n-provider";
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
  /** Drop the card chrome + "Domain" header (when the parent already labels this
   *  section, e.g. the wizard's "Public domain" toggle). The add-domain "+" moves
   *  next to Free/Custom. */
  hideHeader?: boolean;
  /** Place each route's exposed-port field to the right of its domain input. */
  portInline?: boolean;
  /** Hide each route's internal Free/Custom toggle — for callers that drive the
   *  domain type from their own outer control (e.g. the migrate wizard). */
  hideTypeToggle?: boolean;
}

const PublicEndpointsCard: React.FC<PublicEndpointsCardProps> = ({
  projectName,
  endpoints,
  hasServer,
  runtimePort,
  allowPortEdit = true,
  onChange,
  saveMode = "change",
  hideHeader = false,
  portInline = false,
  hideTypeToggle = false,
}) => {
  const { t } = useI18n();
  const w = t.widgets.routing.publicEndpoints;
  const hasMultipleEndpoints = endpoints.length > 1;

  // With multiple domains, collapse each into a compact row so the list isn't
  // a huge stack of full forms — click a row to expand its editor. A single
  // route keeps the full inline form (nothing to collapse).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
      return mappedPort ? interpolate(w.mappedToPort, { port: mappedPort }) : w.noPortYet;
    }

    return interpolate(w.mappedTo, { path: endpoint.targetPath || "/" });
  };

  const renderRoutingCard = (endpoint: PublicEndpoint, actionSlot?: React.ReactNode) => {
    const resolvedUrl = endpoint.domainType === "custom" && endpoint.customDomain
      ? `https://${endpoint.customDomain}`
      : null;
    const readOnlyTarget = !allowPortEdit
      ? {
          label: hasServer ? w.exposedPort : w.staticPath,
          value: hasServer ? (endpoint.port || runtimePort || w.auto) : (endpoint.targetPath || "/"),
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
        actionSlot={actionSlot}
        portInline={portInline}
        hideTypeToggle={hideTypeToggle}
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

  const addButton = (
    <button
      type="button"
      onClick={handleAddEndpoint}
      aria-label={w.addDomain}
      title={w.addDomain}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border/50 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
    >
      <Plus className="size-4" />
    </button>
  );

  // Headerless: no card chrome, no "Domain" header — the parent labels the
  // section. A single route leads with Free/Custom + the add "+" on its right;
  // multiple routes keep the collapsed rows and add via the bottom button.
  if (hideHeader) {
    return (
      <div className="space-y-3">
        {hasMultipleEndpoints ? (
          <>
            {endpoints.map((endpoint, index) => {
              const isOpen = expandedIds.has(endpoint.id);
              const summary =
                (endpoint.domainType === "custom" ? endpoint.customDomain : endpoint.domain) ||
                describeEndpointTarget(endpoint);
              return (
                <div key={endpoint.id} className="rounded-xl border border-border/50 bg-background/40 overflow-hidden">
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(endpoint.id)}
                      aria-expanded={isOpen}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <ChevronDown
                        className={`size-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "" : "-rotate-90"}`}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-foreground leading-tight">
                          {index === 0 ? w.primaryDomain : interpolate(w.domainN, { n: String(index + 1) })}
                        </span>
                        <span className="block truncate text-sm text-muted-foreground">
                          {isOpen ? describeEndpointTarget(endpoint) : summary}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveEndpoint(endpoint.id)}
                      disabled={endpoints.length <= 1}
                      className="inline-flex shrink-0 items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <Trash2 className="size-3.5" />
                      {w.remove}
                    </button>
                  </div>
                  {isOpen && <div className="p-4 border-t border-border/40">{renderRoutingCard(endpoint)}</div>}
                </div>
              );
            })}
            <button
              type="button"
              onClick={handleAddEndpoint}
              className="inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Plus className="size-4" />
              {w.addDomain}
            </button>
          </>
        ) : (
          renderRoutingCard(endpoints[0], addButton)
        )}
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/40">
        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
          <Globe className="size-3.5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground leading-tight">{w.domain}</h3>
          <p className="text-sm text-muted-foreground">
            {hasMultipleEndpoints
              ? interpolate(w.domainsRouted, { count: String(endpoints.length) })
              : w.accessibleWhere}
          </p>
        </div>
        <button
          type="button"
          onClick={handleAddEndpoint}
          className="inline-flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          aria-label={w.addDomain}
          title={w.addDomain}
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {hasMultipleEndpoints ? endpoints.map((endpoint, index) => {
          const isOpen = expandedIds.has(endpoint.id);
          const summary =
            (endpoint.domainType === "custom" ? endpoint.customDomain : endpoint.domain) ||
            describeEndpointTarget(endpoint);
          return (
            <div key={endpoint.id} className="rounded-xl border border-border/50 bg-background/50 overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <button
                  type="button"
                  onClick={() => toggleExpanded(endpoint.id)}
                  aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <ChevronDown
                    className={`size-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "" : "-rotate-90"}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-foreground leading-tight">
                      {index === 0 ? w.primaryDomain : interpolate(w.domainN, { n: String(index + 1) })}
                    </span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {isOpen ? describeEndpointTarget(endpoint) : summary}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveEndpoint(endpoint.id)}
                  disabled={endpoints.length <= 1}
                  className="inline-flex shrink-0 items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Trash2 className="size-3.5" />
                  {w.remove}
                </button>
              </div>

              {isOpen && (
                <div className="p-4 border-t border-border/40">
                  {renderRoutingCard(endpoint)}
                </div>
              )}
            </div>
          );
        }) : renderRoutingCard(endpoints[0])}
      </div>
    </div>
  );
};

export default PublicEndpointsCard;