"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Container,
  Copy,
  ExternalLink,
  Globe,
  Link2,
  Loader2,
  Pencil,
  Power,
  Plus,
  Shield,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { getApiErrorMessage, projectsApi, deployApi, servicesApi, type Service } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";
import { resolveServiceHostnameLabel } from "@repo/core";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";
import {
  createPublicEndpoint,
  ensurePublicEndpoints,
  type PublicEndpoint,
} from "@/context/deployment/types";

interface DnsRecord {
  type: "CNAME" | "A" | "TXT";
  host: string;
  value: string;
}

type DomainTone = "success" | "warning" | "danger" | "neutral";

interface DomainSummaryItem {
  id: string;
  title: string;
  hostname: string;
  typeLabel: string;
  mappedLabel: string;
  liveUrl: string;
  isPrimary: boolean;
  status: { label: string; tone: DomainTone };
  ssl: { label: string; tone: DomainTone };
}

function toEditablePublicEndpoint(endpoint: any): PublicEndpoint {
  return createPublicEndpoint({
    id: typeof endpoint?.id === "string" ? endpoint.id : undefined,
    port:
      endpoint?.port !== undefined && endpoint?.port !== null
        ? String(endpoint.port)
        : "",
    targetPath: endpoint?.targetPath || "",
    domain: endpoint?.domain || "",
    customDomain: endpoint?.customDomain || "",
    domainType: endpoint?.domainType === "custom" ? "custom" : "free",
  });
}

function createProjectEndpointDrafts(
  projectData: Record<string, any>,
  hasServer: boolean,
  runtimePort: string,
): PublicEndpoint[] {
  return ensurePublicEndpoints(
    Array.isArray(projectData.publicEndpoints)
      ? projectData.publicEndpoints.map((endpoint) => toEditablePublicEndpoint(endpoint))
      : undefined,
    hasServer
      ? {
          port: runtimePort,
          domain: projectData.slug || projectData.name || "project",
          domainType: "free",
        }
      : {
          targetPath: "/",
          domain: projectData.slug || projectData.name || "project",
          domainType: "free",
        },
  );
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
      ...(domainType === "custom"
        ? { customDomain }
        : { domain: freeDomain }),
    };
  }

  const targetPath = endpoint.targetPath.trim() || "/";
  return {
    targetPath,
    domainType,
    ...(domainType === "custom"
      ? { customDomain }
      : { domain: freeDomain }),
  };
}

function resolveProjectEndpointHostname(endpoint: any, baseDomain: string): string {
  if (typeof endpoint?.hostname === "string" && endpoint.hostname.trim()) {
    return endpoint.hostname.trim().toLowerCase();
  }

  if (endpoint?.domainType === "custom") {
    return endpoint?.customDomain?.trim().toLowerCase() || "";
  }

  const domain = endpoint?.domain?.trim().toLowerCase();
  return domain ? `${domain}.${baseDomain}` : "";
}

function resolveDomainStatus(domain: any): { label: string; tone: DomainTone } {
  if (domain?.verified) {
    return { label: "Verified", tone: "success" };
  }

  switch (domain?.status) {
    case "active":
      return { label: "Active", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "removing":
      return { label: "Removing", tone: "neutral" };
    default:
      return { label: "Pending", tone: "warning" };
  }
}

function resolveDomainSsl(hostname: string, domain: any, baseDomain: string): { label: string; tone: DomainTone } {
  if (hostname.endsWith(`.${baseDomain}`)) {
    return { label: "Included by host", tone: "success" };
  }

  switch (domain?.sslStatus) {
    case "active":
      return { label: "Active", tone: "success" };
    case "provisioning":
      return { label: "Provisioning", tone: "warning" };
    case "expired":
      return { label: "Expired", tone: "danger" };
    case "error":
      return { label: "Error", tone: "danger" };
    default:
      return { label: "Inactive", tone: "neutral" };
  }
}

export const DomainSettings = () => {
  const {
    domainsData,
    updateDomains,
    id,
    projectData,
    setProjectData,
    buildData,
    refreshAnalytics,
    servicesData,
    refreshServices,
  } = useProjectSettings();
  const { showToast } = useToast();
  const { baseDomain } = usePlatform();

  const [newDomain, setNewDomain] = useState("");
  const [showCustomDomainSection, setShowCustomDomainSection] = useState(false);
  const [includeWww, setIncludeWww] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sslData, setSSLData] = useState<any>(null);
  const [isLoadingSSL, setIsLoadingSSL] = useState(false);
  const [isRenewingSSL, setIsRenewingSSL] = useState(false);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [dnsMode, setDnsMode] = useState<"cloud" | "selfhosted">("cloud");
  const [editingRouteServiceId, setEditingRouteServiceId] = useState<string | null>(null);
  const [routeSavingServiceId, setRouteSavingServiceId] = useState<string | null>(null);
  const [isSavingPublicEndpoints, setIsSavingPublicEndpoints] = useState(false);
  const [isEditingDomains, setIsEditingDomains] = useState(false);
  const services = servicesData.services;
  const servicesLoading = servicesData.isLoading;
  const hasProjectServer = projectData.options?.hasServer ?? buildData.hasServer ?? true;
  const projectRuntimePort = String(
    projectData.options?.productionPort ||
    buildData.productionPort ||
    projectData.port ||
    "",
  );
  const hasProjectLevelRouting =
    (Array.isArray(projectData.publicEndpoints) && projectData.publicEndpoints.length > 0) ||
    services.length === 0;
  const draftPublicEndpoints = useMemo(
    () => createProjectEndpointDrafts(projectData, hasProjectServer, projectRuntimePort),
    [projectData, hasProjectServer, projectRuntimePort],
  );
  const [publicEndpoints, setPublicEndpoints] = useState<PublicEndpoint[]>(draftPublicEndpoints);

  const domainSummaries = useMemo<DomainSummaryItem[]>(() => {
    const endpointSource = Array.isArray(projectData.publicEndpoints) && projectData.publicEndpoints.length > 0
      ? projectData.publicEndpoints
      : publicEndpoints;
    const domains = Array.isArray(domainsData.domains) ? domainsData.domains : [];
    const domainById = new Map(
      domains
        .filter((domain) => typeof domain?.id === "string")
        .map((domain) => [domain.id, domain]),
    );
    const domainByHostname = new Map(
      domains
        .filter((domain) => typeof domain?.hostname === "string")
        .map((domain) => [domain.hostname.toLowerCase(), domain]),
    );

    return endpointSource
      .map((endpoint: any, index: number) => {
        const hostname = resolveProjectEndpointHostname(endpoint, baseDomain);
        if (!hostname) return null;

        const domain =
          (typeof endpoint?.id === "string" ? domainById.get(endpoint.id) : undefined) ||
          domainByHostname.get(hostname) ||
          null;
        const mappedPort = endpoint?.port !== undefined && endpoint?.port !== null
          ? String(endpoint.port)
          : projectRuntimePort;

        return {
          id: endpoint?.id || hostname,
          title: index === 0 ? "Primary domain" : `Domain ${index + 1}`,
          hostname,
          typeLabel: endpoint?.domainType === "custom" ? "Custom domain" : "Free subdomain",
          mappedLabel: hasProjectServer
            ? (mappedPort ? `Port ${mappedPort}` : "No port selected")
            : (endpoint?.targetPath || "/"),
          liveUrl: `https://${hostname}`,
          isPrimary: index === 0,
          status: resolveDomainStatus(domain),
          ssl: resolveDomainSsl(hostname, domain, baseDomain),
        } satisfies DomainSummaryItem;
      })
      .filter((domain): domain is DomainSummaryItem => domain !== null);
  }, [projectData.publicEndpoints, publicEndpoints, domainsData.domains, baseDomain, hasProjectServer, projectRuntimePort]);

  const primaryProjectDomain = domainSummaries[0] ?? null;

  const primaryDomainName = primaryProjectDomain?.hostname || "";
  const localPort = projectData.port || projectData.options?.productionPort || 3000;
  const localUrl = `localhost:${localPort}`;
  const hasDomain = !!primaryDomainName;
  const currentUrl = hasDomain ? primaryDomainName : localUrl;
  const currentHref = hasDomain ? `https://${primaryDomainName}` : `http://${localUrl}`;
  const isManagedHostDomain = hasDomain && primaryDomainName.endsWith(`.${baseDomain}`);
  const dnsRouteValue = dnsRecords.find((record) => record.type !== "TXT")?.value || "";

  useEffect(() => {
    setPublicEndpoints(draftPublicEndpoints);
  }, [draftPublicEndpoints]);

  const domainMeta = useMemo(() => {
    if (!hasDomain) {
      return {
        title: "Access URL",
        subtitle: "Local development endpoint",
        typeLabel: "Local",
        statusLabel: "Available on this machine",
        statusTone: "neutral" as const,
      };
    }

    if (isManagedHostDomain) {
      return {
        title: "Primary Domain",
        subtitle:
          domainSummaries.length > 1
            ? `Primary route across ${domainSummaries.length} domains`
            : "Host-managed production URL",
        typeLabel: primaryProjectDomain?.typeLabel || "Free subdomain",
        statusLabel: primaryProjectDomain?.status.label || "Verified",
        statusTone: primaryProjectDomain?.status.tone || ("success" as const),
      };
    }

    return {
      title: "Primary Domain",
      subtitle:
        domainSummaries.length > 1
          ? `Primary route across ${domainSummaries.length} domains`
          : "Custom production domain",
      typeLabel: primaryProjectDomain?.typeLabel || "Custom domain",
      statusLabel: primaryProjectDomain?.status.label || "Pending",
      statusTone: primaryProjectDomain?.status.tone || ("warning" as const),
    };
  }, [hasDomain, isManagedHostDomain, domainSummaries.length, primaryProjectDomain]);

  useEffect(() => {
    const fetchSSLStatus = async () => {
      if (!primaryDomainName || isManagedHostDomain) return;

      setIsLoadingSSL(true);
      try {
        const result = await deployApi.sslStatus(primaryDomainName);
        if (result.success) {
          setSSLData(result);
        }
      } catch (error) {
        console.error("Failed to fetch SSL status:", error);
      } finally {
        setIsLoadingSSL(false);
      }
    };

    void fetchSSLStatus();
  }, [primaryDomainName, isManagedHostDomain]);

  useEffect(() => {
    if (!editingRouteServiceId) return;
    if (!services.some((service) => service.id === editingRouteServiceId)) {
      setEditingRouteServiceId(null);
    }
  }, [editingRouteServiceId, services]);

  const handleSubmitDomains = async () => {
    const trimmedDomain = newDomain.trim();
    if (!trimmedDomain) return;

    setIsSubmitting(true);

    const result = await projectsApi.connectDomain(id, {
      domain: trimmedDomain,
      includeWww,
    });

    if (!result.success) {
      showToast(
        result.error || "Failed to connect domain",
        "error",
        result.message || "Failed to connect domain",
      );
      setIsSubmitting(false);
      return;
    }

    if (result.records?.records) {
      setDnsRecords(result.records.records);
      setDnsMode(result.records.mode ?? "cloud");
    }

    const newDomainObj = {
      id: Date.now(),
      domain: trimmedDomain,
      primary: true,
      verified: true,
    };

    const updatedDomains = [
      ...domainsData.domains.map((d) => ({ ...d, primary: false })),
      newDomainObj,
    ];

    await updateDomains(updatedDomains);
    showToast("Domain connected", "success", "DNS records are ready below");
    setIsSubmitting(false);
    setShowCustomDomainSection(true);
  };

  const handleCopy = async (text: string) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    showToast("Copied to clipboard", "success");
  };

  const handleRenewSSL = async () => {
    if (!primaryDomainName) return;

    setIsRenewingSSL(true);
    try {
      const result = await deployApi.sslRenew(primaryDomainName, false);

      if (result.success) {
        showToast("SSL certificate renewed successfully", "success");
        const statusResult = await deployApi.sslStatus(primaryDomainName);
        if (statusResult.success) {
          setSSLData(statusResult);
        }
      } else {
        showToast(
          result.message || result.error || "Failed to renew SSL certificate",
          "error",
          result.message,
        );
      }
    } catch (error) {
      console.error("Failed to renew SSL:", error);
      showToast("Failed to renew SSL certificate", "error");
    } finally {
      setIsRenewingSSL(false);
    }
  };

  const handleStartEditingDomains = () => {
    setPublicEndpoints(draftPublicEndpoints);
    setIsEditingDomains(true);
  };

  const handleCancelEditingDomains = () => {
    setPublicEndpoints(draftPublicEndpoints);
    setIsEditingDomains(false);
  };

  const handleSavePublicEndpoints = async () => {
    const payload = publicEndpoints
      .map((endpoint) => buildPublicEndpointPayload(endpoint, hasProjectServer))
      .filter((endpoint): endpoint is NonNullable<ReturnType<typeof buildPublicEndpointPayload>> => endpoint !== null);

    if (payload.length !== publicEndpoints.length || payload.length === 0) {
      showToast("Complete every domain and mapped port before saving", "error", "Domains");
      return false;
    }

    const primaryPort = hasProjectServer && "port" in payload[0]
      ? payload[0].port
      : undefined;

    setIsSavingPublicEndpoints(true);
    try {
      await projectsApi.patch(id, {
        publicEndpoints: payload,
        ...(typeof primaryPort === "number" ? { port: primaryPort } : {}),
      });

      setProjectData((prev) => ({
        ...prev,
        publicEndpoints: payload,
        ...(typeof primaryPort === "number" ? { port: primaryPort } : {}),
        options: {
          ...(prev.options || {}),
          ...(typeof primaryPort === "number" ? { productionPort: String(primaryPort) } : {}),
          hasServer: hasProjectServer,
        },
      }));

      await updateDomains(payload.map((endpoint, index) => {
        const hostname = endpoint.domainType === "custom"
          ? endpoint.customDomain || ""
          : `${endpoint.domain}.${baseDomain}`;
        const existing = domainsData.domains.find((domain) => (
          (typeof domain?.id === "string" && domain.id === publicEndpoints[index]?.id) ||
          domain?.hostname === hostname
        ));

        return {
          ...existing,
          id: existing?.id || publicEndpoints[index]?.id || hostname,
          hostname,
          domain: hostname,
          primary: index === 0,
          isPrimary: index === 0,
          verified: existing?.verified ?? true,
          status: existing?.status ?? "active",
          sslStatus: existing?.sslStatus ?? (endpoint.domainType === "free" ? "active" : "none"),
          targetPort: endpoint.port ?? null,
          targetPath: endpoint.targetPath ?? null,
          domainType: endpoint.domainType,
        };
      }));

      await refreshAnalytics(true);
      showToast("Domain routing updated", "success", "Domains");
      setIsEditingDomains(false);
      return true;
    } catch (error) {
      showToast(getApiErrorMessage(error, "Failed to update domain routing"), "error", "Domains");
      return false;
    } finally {
      setIsSavingPublicEndpoints(false);
    }
  };

  const projectLabel = projectData.slug || projectData.name || "project";

  const resolveServiceHostname = (service: Service) => {
    if (service.domainType === "custom" && service.customDomain) {
      return service.customDomain;
    }
    return `${resolveServiceHostnameLabel(projectLabel, service.name, service.domain)}.${baseDomain}`;
  };

  const getServiceRouteSummary = (service: Service) => {
    const liveUrl = service.exposed ? `https://${resolveServiceHostname(service)}` : null;

    if (!service.enabled) {
      return {
        connected: false,
        statusLabel: "Disabled",
        statusClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        detail: service.exposed ? "Route paused" : "Service disabled",
        liveUrl,
      };
    }

    if (!service.exposed) {
      return {
        connected: false,
        statusLabel: "Internal",
        statusClass: "bg-muted/60 text-muted-foreground/70",
        detail: "Not exposed",
        liveUrl: null as string | null,
      };
    }

    return {
      connected: true,
      statusLabel: "Public",
      statusClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      detail: service.domainType === "custom" ? "Custom domain" : "Free subdomain",
      liveUrl,
    };
  };

  const handleServiceRouteUpdate = async (serviceId: string, patch: Partial<Service>) => {
    setRouteSavingServiceId(serviceId);
    try {
      const result = await servicesApi.update(id, serviceId, patch);
      if (!result.success) {
        throw new Error("Failed to update service route");
      }
      await refreshServices();
    } catch (error) {
      console.error("Failed to update service route:", error);
      showToast("Failed to update service route", "error");
    } finally {
      setRouteSavingServiceId(null);
    }
  };

  const editingRouteService =
    services.find((service) => service.id === editingRouteServiceId) ?? null;
  const editingRoute = editingRouteService ? getServiceRouteSummary(editingRouteService) : null;

  const sslStatusLabel = isLoadingSSL
    ? "Loading"
    : sslData?.status === "expired"
      ? "Expired"
      : sslData?.status === "expiring_soon"
        ? `Expiring in ${sslData?.daysUntilExpiry} days`
        : sslData?.enabled
          ? "Active"
          : "Inactive";

  const sslStatusTone =
    sslData?.status === "expired"
      ? "danger"
      : sslData?.status === "expiring_soon"
        ? "warning"
        : sslData?.enabled || isManagedHostDomain
          ? "success"
          : "neutral";

  const hasMultipleProjectDomains = domainSummaries.length > 1;
  const singleDomainActions = (
    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
      <ActionButton href={currentHref} label="Visit" icon={ExternalLink} />
      {hasProjectLevelRouting ? (
        <ActionButton label="Edit domains" icon={Pencil} onClick={handleStartEditingDomains} />
      ) : null}
      <ActionButton
        label={showCustomDomainSection ? "Hide setup" : "Add domain"}
        icon={Plus}
        onClick={() => setShowCustomDomainSection((value) => !value)}
      />
    </div>
  );
  const multiDomainActions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <ActionButton label="Edit domains" icon={Pencil} onClick={handleStartEditingDomains} />
      <ActionButton
        label={showCustomDomainSection ? "Hide setup" : "Add domain"}
        icon={Plus}
        onClick={() => setShowCustomDomainSection((value) => !value)}
      />
    </div>
  );

  return (
    <div className="space-y-5">
      {!isEditingDomains && !hasMultipleProjectDomains ? (
        <div className={`grid grid-cols-1 ${hasDomain ? "lg:grid-cols-2" : ""} gap-5`}>
          <SectionCard
            title={domainMeta.title}
            description={domainMeta.subtitle}
            icon={Globe}
            iconTone="primary"
            headerBadge={hasDomain ? (
              <StatusPill tone={domainMeta.statusTone}>{domainMeta.statusLabel}</StatusPill>
            ) : undefined}
            actions={singleDomainActions}
          >
            <ValueBlock label={hasDomain ? "Domain" : "Local URL"} value={currentUrl} />
            <InfoRow label="Type" value={domainMeta.typeLabel} />
            {primaryProjectDomain ? (
              <InfoRow
                label={hasProjectServer ? "Mapped to" : "Path"}
                value={primaryProjectDomain.mappedLabel}
              />
            ) : null}
            {!hasDomain ? (
              <InfoRow
                label="Status"
                value={<StatusPill tone={domainMeta.statusTone}>{domainMeta.statusLabel}</StatusPill>}
              />
            ) : null}
          </SectionCard>

          {hasDomain && (
            <SectionCard
              title="SSL Certificate"
              description="Certificate state for the production domain"
              icon={isManagedHostDomain ? ShieldCheck : Shield}
              iconTone="emerald"
              actions={
                !isManagedHostDomain ? (
                  <ActionButton
                    label={isRenewingSSL ? "Renewing..." : "Renew SSL"}
                    icon={isRenewingSSL ? Loader2 : ShieldAlert}
                    onClick={handleRenewSSL}
                    disabled={isRenewingSSL || isLoadingSSL || !sslData?.enabled}
                  />
                ) : undefined
              }
            >
              <InfoRow
                label="Status"
                value={<StatusPill tone={sslStatusTone as any}>{sslStatusLabel}</StatusPill>}
              />
              <InfoRow
                label="Issuer"
                value={isManagedHostDomain ? "Managed by host" : sslData?.issuer || "Let's Encrypt"}
              />
              <InfoRow
                label="Expires"
                value={
                  isManagedHostDomain
                    ? "Included"
                    : sslData?.expiresAt
                      ? new Date(sslData.expiresAt).toLocaleDateString()
                      : "N/A"
                }
              />
              <div className="rounded-xl bg-muted/35 px-4 py-3 text-[12px] text-muted-foreground">
                {isManagedHostDomain
                  ? "Free subdomains are covered by host-managed SSL. Custom domains can be renewed from here when needed."
                  : sslData?.enabled
                    ? "Use renew when you want to force a fresh certificate check for this custom domain."
                    : "SSL becomes renewable after DNS verification and certificate provisioning complete."}
              </div>
            </SectionCard>
          )}
        </div>
      ) : null}

      {!isEditingDomains && hasMultipleProjectDomains ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-end gap-2">{multiDomainActions}</div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {domainSummaries.map((domain) => (
              <DomainOverviewCard
                key={domain.id}
                domain={domain}
                actions={domain.liveUrl ? <ActionButton href={domain.liveUrl} label="Visit" icon={ExternalLink} /> : null}
              />
            ))}
          </div>
        </div>
      ) : null}

      {hasProjectLevelRouting && isEditingDomains ? (
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-[14px] font-semibold text-foreground">Edit domains</h3>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {hasProjectServer
                  ? "Edit which internal port each domain should route to."
                  : "Edit which static path each domain should serve."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleCancelEditingDomains}
                disabled={isSavingPublicEndpoints}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-foreground/[0.06] px-4 py-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="size-4" />
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSavePublicEndpoints()}
                disabled={isSavingPublicEndpoints}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSavingPublicEndpoints ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-4" />
                )}
                {isSavingPublicEndpoints ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>

          <PublicEndpointsCard
            projectName={projectLabel}
            endpoints={publicEndpoints}
            hasServer={hasProjectServer}
            runtimePort={publicEndpoints[0]?.port || projectRuntimePort}
            onChange={(nextEndpoints) => setPublicEndpoints(nextEndpoints)}
          />
        </div>
      ) : null}

      {showCustomDomainSection && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <SectionCard
            title="Custom Domain"
            description="Attach your own domain and keep it as the production entrypoint"
            icon={Plus}
            iconTone="blue"
          >
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-foreground">Domain name</label>
                <input
                  placeholder="yourdomain.com"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40"
                />
              </div>

              <div className="flex items-center justify-between rounded-xl border border-border/50 bg-muted/25 px-4 py-3">
                <div>
                  <p className="text-[13px] font-medium text-foreground">Include www</p>
                  <p className="text-[12px] text-muted-foreground">
                    Also generate records for www.{newDomain || "yourdomain.com"}
                  </p>
                </div>
                <button
                  onClick={() => setIncludeWww((value) => !value)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${includeWww ? "bg-primary" : "bg-muted"}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${includeWww ? "translate-x-6" : "translate-x-1"}`}
                  />
                </button>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={handleSubmitDomains}
                  disabled={!newDomain.trim() || isSubmitting}
                  className="inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  {isSubmitting ? "Preparing records" : "Connect domain"}
                </button>
              </div>
            </div>
          </SectionCard>

          <SectionCard
            title="DNS Records"
            description="Apply these records at your DNS provider, then wait for propagation"
            icon={Link2}
            iconTone="orange"
          >
            <div className="space-y-3">
              {dnsRecords.length > 0 ? (
                dnsRecords.map((record, index) => (
                  <DnsRecordRow
                    key={`${record.type}-${record.host}-${index}`}
                    record={record}
                    onCopy={handleCopy}
                  />
                ))
              ) : (
                <>
                  <DnsRecordPlaceholder
                    type={dnsMode === "selfhosted" ? "A" : "CNAME"}
                    host="@"
                    value={
                      dnsMode === "selfhosted" ? "your server IP" : "target generated after connect"
                    }
                  />
                  <DnsRecordPlaceholder
                    type="TXT"
                    host="_openship-challenge"
                    value="verification token"
                  />
                </>
              )}

              {includeWww && (
                <DnsRecordPlaceholder
                  type={dnsMode === "selfhosted" ? "A" : "CNAME"}
                  host="www"
                  value={dnsRouteValue || "same as root record"}
                />
              )}
            </div>

            <div className="rounded-xl bg-muted/35 px-4 py-3 text-[12px] text-muted-foreground">
              DNS changes can take up to 48 hours to propagate globally. Once the records resolve,
              verification and SSL provisioning will follow automatically.
            </div>
          </SectionCard>
        </div>
      )}

      {!hasProjectLevelRouting && (servicesLoading || services.length > 0) && (
        <SectionCard
          title="Service Routing"
          description={`${services.filter((s) => s.exposed).length} of ${services.length} services exposed publicly`}
          icon={Container}
          iconTone="primary"
        >
          {servicesLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Loading services...
            </div>
          ) : services.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No services found for this project.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/40 divide-y divide-border/30">
              {services.map((service) => {
                const route = getServiceRouteSummary(service);
                const isServiceSaving = routeSavingServiceId === service.id;
                const routeLabel = route.liveUrl
                  ? route.liveUrl.replace("https://", "")
                  : "Internal only";

                return (
                  <div key={service.id} className="bg-card">
                    <div className="flex w-full items-center gap-4 px-4 py-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-foreground">
                            {service.name}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${route.statusClass}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${route.connected ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                            />
                            {route.statusLabel}
                          </span>
                        </div>

                        <div className="mt-3 rounded-xl border border-border/50 bg-muted/25 px-3.5 py-3">
                          <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                            Route
                          </div>
                          <div className="mt-1.5 truncate text-[13px] font-semibold text-foreground">
                            {routeLabel}
                          </div>
                        </div>
                        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <Link2 className="size-3" />
                          <span>Port {service.exposedPort || "Auto"}</span>
                          <span className="text-muted-foreground/50">·</span>
                          <span>{route.detail}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {route.connected && route.liveUrl && (
                          <a
                            href={route.liveUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors"
                          >
                            <ExternalLink className="size-3" />
                            Open
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            handleServiceRouteUpdate(service.id, { enabled: !service.enabled })
                          }
                          disabled={isServiceSaving}
                          className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            service.enabled
                              ? "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/15"
                              : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/15"
                          }`}
                        >
                          {isServiceSaving ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Power className="size-3" />
                          )}
                          {service.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingRouteServiceId(service.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-foreground/[0.06] text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
                        >
                          Edit route
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
      )}

      {editingRouteService && editingRoute && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
          onClick={() => setEditingRouteServiceId(null)}
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-2xl border border-border/60 bg-card shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-4">
              <div className="min-w-0">
                <h3 className="text-[14px] font-semibold text-foreground">Edit route</h3>
                <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  {editingRouteService.name}
                  {editingRoute.liveUrl
                    ? ` · ${editingRoute.liveUrl.replace("https://", "")}`
                    : " · Internal only"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingRouteServiceId(null)}
                className="inline-flex min-h-9 items-center rounded-xl bg-foreground/[0.06] px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
              >
                Close
              </button>
            </div>

            <div className="px-5 py-5">
              <RoutingSettingsCard
                projectName={projectLabel}
                domain={editingRouteService.domain ?? ""}
                customDomain={editingRouteService.customDomain ?? ""}
                domainType={editingRouteService.domainType === "custom" ? "custom" : "free"}
                exposed={editingRouteService.exposed}
                ports={editingRouteService.ports}
                exposedPort={editingRouteService.exposedPort ?? ""}
                disabled={routeSavingServiceId === editingRouteService.id}
                liveUrl={editingRoute.connected ? editingRoute.liveUrl : null}
                onExposedChange={(value) =>
                  handleServiceRouteUpdate(editingRouteService.id, { exposed: value })
                }
                onDomainTypeChange={(value) =>
                  handleServiceRouteUpdate(editingRouteService.id, { domainType: value })
                }
                onDomainChange={(value) =>
                  handleServiceRouteUpdate(editingRouteService.id, { domain: value })
                }
                onCustomDomainChange={(value) =>
                  handleServiceRouteUpdate(editingRouteService.id, { customDomain: value })
                }
                onExposedPortChange={(value) =>
                  handleServiceRouteUpdate(editingRouteService.id, { exposedPort: value })
                }
                saveMode="explicit"
              />
              {!editingRouteService.enabled && editingRouteService.exposed && (
                <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
                  Service is disabled — routes are inactive until the service is re-enabled.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  emerald: "bg-emerald-500/10 text-emerald-500",
  blue: "bg-blue-500/10 text-blue-500",
  orange: "bg-orange-500/10 text-orange-500",
} as const;

function SectionCard({
  title,
  description,
  icon: Icon,
  iconTone = "primary",
  headerBadge,
  actions,
  children,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  iconTone?: keyof typeof ICON_TONES;
  headerBadge?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
      <div className="border-b border-border/40 px-5 py-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ICON_TONES[iconTone]}`}
          >
            <Icon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
          </div>
          {headerBadge ? <div className="shrink-0 self-start">{headerBadge}</div> : null}
        </div>
        {actions ? <div className="mt-4">{actions}</div> : null}
      </div>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div className="text-right">
        {typeof value === "string" ? (
          <span className="text-[13px] font-medium text-foreground">{value}</span>
        ) : (
          value
        )}
      </div>
    </div>
  );
}

function ValueBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/50 bg-muted/25 px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
        {label}
      </div>
      <div className="mt-2 break-all text-[14px] font-semibold text-foreground">{value}</div>
    </div>
  );
}

function StatusPill({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "neutral";
  children: React.ReactNode;
}) {
  const styles = {
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    danger: "bg-red-500/10 text-red-600 dark:text-red-400",
    neutral: "bg-muted/60 text-muted-foreground",
  }[tone];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${styles}`}
    >
      {tone === "success" ? <CheckCircle2 className="size-3" /> : null}
      {tone === "warning" || tone === "danger" ? <ShieldAlert className="size-3" /> : null}
      {children}
    </span>
  );
}

function ActionButton({
  label,
  icon: Icon,
  href,
  onClick,
  disabled,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const className =
    "inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-foreground/[0.06] px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:cursor-not-allowed disabled:opacity-50";

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        <Icon className="size-3.5" />
        {label}
      </a>
    );
  }

  return (
    <button onClick={onClick} disabled={disabled} className={className}>
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

function DomainOverviewCard({
  domain,
  actions,
}: {
  domain: DomainSummaryItem;
  actions?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
      <div className="border-b border-border/40 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-semibold text-foreground">{domain.title}</h3>
            {domain.isPrimary ? (
              <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
                Primary
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">{domain.typeLabel}</p>
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        <ValueBlock label="Domain" value={domain.hostname} />
        <InfoRow label="Mapped to" value={domain.mappedLabel} />
        <InfoRow label="Status" value={<StatusPill tone={domain.status.tone}>{domain.status.label}</StatusPill>} />
        <InfoRow label="SSL" value={<StatusPill tone={domain.ssl.tone}>{domain.ssl.label}</StatusPill>} />
      </div>

      {actions ? (
        <div className="border-t border-border/40 bg-muted/[0.14] px-5 py-3">
          <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
        </div>
      ) : null}
    </div>
  );
}

function DnsRecordRow({
  record,
  onCopy,
}: {
  record: DnsRecord;
  onCopy: (text: string) => void | Promise<void>;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
            {record.type}
          </div>
          <div className="mt-1 text-[13px] font-medium text-foreground">{record.host}</div>
          <code className="mt-2 block break-all text-[12px] text-muted-foreground">
            {record.value || "—"}
          </code>
        </div>
        {record.value ? (
          <button
            onClick={() => onCopy(record.value)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            title="Copy"
          >
            <Copy className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DnsRecordPlaceholder({
  type,
  host,
  value,
}: {
  type: string;
  host: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-muted/15 px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
        {type}
      </div>
      <div className="mt-1 text-[13px] font-medium text-foreground">{host}</div>
      <div className="mt-2 text-[12px] text-muted-foreground">{value}</div>
    </div>
  );
}
