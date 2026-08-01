"use client";

import React, { useState } from "react";
import { ChevronDown, Globe, Plus, Trash2 } from "lucide-react";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";
import { Switch } from "@/components/ui/Switch";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { PublicEndpoint } from "@/context/deployment/types";
import { createPublicEndpoint } from "@/context/deployment/types";
import { useDefaultDomainType } from "@/context/CloudContext";
import { usePlatform } from "@/context/PlatformContext";
import { resolvePublicEndpointHostname } from "@/lib/public-endpoint-payload";

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
  /** Allow removing EVERY domain (down to zero = internal-only). Off by default so
   *  deploy/migrate flows keep ≥1 route; the project domains tab opts in so a user
   *  can delete their only/last domain and re-add one. */
  allowRemoveAll?: boolean;
  /** Optional "Include www." switch shown as the first row of the domain card,
   *  for the apex custom domain. `apex` is the bare apex (null until one is typed);
   *  `show` hides it for subdomains (where `www.<sub>` is nonsensical). Only the
   *  primary/apex input gets the `www.` auto-strip — never the `www.<apex>` row. */
  wwwToggle?: {
    show: boolean;
    included: boolean;
    apex: string | null;
    onToggle: (on: boolean) => void;
  };
  /**
   * Offer the per-endpoint "Redirect to" control (a hostname answers a 30x to
   * another of the project's hostnames instead of serving). Off by default; the
   * caller opts in where it applies — never for a cloud project, whose routing the
   * managed edge owns.
   */
  allowRedirects?: boolean;
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
  allowRemoveAll = false,
  wwwToggle,
  allowRedirects = false,
}) => {
  const { t } = useI18n();
  const { baseDomain } = usePlatform();
  const w = t.widgets.routing.publicEndpoints;
  const hasMultipleEndpoints = endpoints.length > 1;
  const newEndpointDomainType = useDefaultDomainType();

  /** Shared with the project Domains tab — one answer for "which host is this?". */
  const endpointHostname = (endpoint: PublicEndpoint): string =>
    resolvePublicEndpointHostname(endpoint, baseDomain);

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
              domainType: newEndpointDomainType,
            }
          : {
              targetPath: lastEndpoint?.targetPath || "/",
              domainType: newEndpointDomainType,
            },
      )),
    ]);
  };

  const handleRemoveEndpoint = (endpointId: string) => {
    // With allowRemoveAll the last domain can go → 0 (internal-only); otherwise
    // keep ≥1 (deploy/migrate flows need a target).
    if (endpoints.length <= (allowRemoveAll ? 0 : 1)) {
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

    // Auto-strip `www.` on the primary/apex custom input only — NOT the
    // `www.<apex>` variant endpoint (stripping it would collapse it into the apex).
    const isWwwVariant =
      !!wwwToggle?.apex &&
      endpoint.domainType === "custom" &&
      endpoint.customDomain.trim().toLowerCase() === `www.${wwwToggle.apex}`;
    const stripWww = !!wwwToggle && endpoint.domainType === "custom" && !isWwwVariant;

    // Redirect targets = the project's OTHER named hostnames. A closed list, so a
    // redirect can never point off-site; an endpoint with no hostname yet (freshly
    // added row) isn't offerable as a target.
    const redirectTargets = allowRedirects
      ? endpoints
          .filter((other) => other.id !== endpoint.id)
          .map((other) => endpointHostname(other))
          .filter((hostname): hostname is string => !!hostname)
      : [];

    return (
      <RoutingSettingsCard
        projectName={projectName}
        domain={endpoint.domain}
        customDomain={endpoint.customDomain}
        domainType={endpoint.domainType}
        stripWww={stripWww}
        targetMode={hasServer ? "proxy" : "static"}
        targetPath={hasServer ? undefined : endpoint.targetPath}
        exposedPort={hasServer ? endpoint.port : undefined}
        readOnlyTarget={readOnlyTarget}
        liveUrl={resolvedUrl}
        actionSlot={actionSlot}
        portInline={portInline}
        hideTypeToggle={hideTypeToggle}
        redirect={
          redirectTargets.length > 0
            ? {
                to: endpoint.redirectTo ?? "",
                status: endpoint.redirectStatus ?? 301,
                targets: redirectTargets,
                onChange: ({ to, status }) =>
                  handleEndpointChange(endpoint.id, {
                    redirectTo: to || undefined,
                    redirectStatus: to ? status : undefined,
                  }),
              }
            : undefined
        }
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
    // No domains. With allowRemoveAll this is a valid state (internal-only) — keep
    // an "add domain" affordance so the user can add one back; otherwise render
    // nothing (the parent owns the empty case).
    if (!allowRemoveAll) return null;
    return (
      <button
        type="button"
        onClick={handleAddEndpoint}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-background/40 px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
      >
        <Plus className="size-4" />
        {w.addDomain}
      </button>
    );
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

  // Trash control for the single-endpoint layouts (the multi-endpoint rows carry
  // their own). Only meaningful when allowRemoveAll lets the last domain go → 0.
  const removeButton = (endpointId: string) => (
    <button
      type="button"
      onClick={() => handleRemoveEndpoint(endpointId)}
      aria-label={w.remove}
      title={w.remove}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border/50 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      <Trash2 className="size-4" />
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
          renderRoutingCard(
            endpoints[0],
            <>
              {allowRemoveAll && removeButton(endpoints[0].id)}
              {addButton}
            </>,
          )
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
        }) : renderRoutingCard(
          endpoints[0],
          allowRemoveAll ? removeButton(endpoints[0].id) : undefined,
        )}

        {/* Single compact row, kept UNDER the domain input so toggling it (or its
            appearance once a domain is typed) never shifts the input above. */}
        {wwwToggle?.show && (
          <div className="flex items-center justify-between gap-4 rounded-xl bg-muted/30 px-4 py-3">
            <span className="text-[13px] font-medium text-foreground">
              {t.projectSettings.domains.add.includeWww}
            </span>
            <Switch
              checked={wwwToggle.included}
              onChange={(next) => wwwToggle.onToggle(next)}
              ariaLabel={t.projectSettings.domains.add.includeWww}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default PublicEndpointsCard;