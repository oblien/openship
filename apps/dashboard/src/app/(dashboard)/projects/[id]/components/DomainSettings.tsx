"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Container,
  Copy,
  ExternalLink,
  Globe,
  Link2,
  Loader2,
  Plus,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { projectsApi, deployApi, servicesApi, type Service } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";
import { getProjectType, resolveServiceHostnameLabel } from "@repo/core";
import { useRouter } from "next/navigation";

interface DnsRecord {
  type: "CNAME" | "A" | "TXT";
  host: string;
  value: string;
}

export const DomainSettings = () => {
  const { domainsData, updateDomains, id, projectData } = useProjectSettings();
  const { showToast } = useToast();
  const router = useRouter();
  const { baseDomain } = usePlatform();
  const isServicesProject = getProjectType(projectData.framework as any) === "services";

  const [newDomain, setNewDomain] = useState("");
  const [showCustomDomainSection, setShowCustomDomainSection] = useState(false);
  const [includeWww, setIncludeWww] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sslData, setSSLData] = useState<any>(null);
  const [isLoadingSSL, setIsLoadingSSL] = useState(false);
  const [isRenewingSSL, setIsRenewingSSL] = useState(false);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [dnsMode, setDnsMode] = useState<"cloud" | "selfhosted">("cloud");
  const [services, setServices] = useState<Service[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);

  const primaryDomain = domainsData?.domains?.find((d) => d.primary) || domainsData?.domains?.[0] || null;
  const primaryDomainName = typeof primaryDomain?.domain === "string" ? primaryDomain.domain : "";
  const localPort = projectData.port || projectData.options?.productionPort || 3000;
  const localUrl = `localhost:${localPort}`;
  const hasDomain = !!primaryDomainName;
  const currentUrl = hasDomain ? primaryDomainName : localUrl;
  const currentHref = hasDomain ? `https://${primaryDomainName}` : `http://${localUrl}`;
  const isManagedHostDomain = hasDomain && primaryDomainName.endsWith(`.${baseDomain}`);
  const dnsRouteValue = dnsRecords.find((record) => record.type !== "TXT")?.value || "";

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
        subtitle: "Host-managed production URL",
        typeLabel: "Free subdomain",
        statusLabel: primaryDomain?.verified ? "Verified" : "Pending verification",
        statusTone: primaryDomain?.verified ? "success" as const : "warning" as const,
      };
    }

    return {
      title: "Primary Domain",
      subtitle: "Custom production domain",
      typeLabel: "Custom domain",
      statusLabel: primaryDomain?.verified ? "Verified" : "Pending verification",
      statusTone: primaryDomain?.verified ? "success" as const : "warning" as const,
    };
  }, [hasDomain, isManagedHostDomain, primaryDomain?.verified]);

  useEffect(() => {
    const fetchSSLStatus = async () => {
      if (isServicesProject || !primaryDomainName || isManagedHostDomain) return;

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
  }, [isServicesProject, primaryDomainName, isManagedHostDomain]);

  useEffect(() => {
    if (!isServicesProject) {
      setServices([]);
      setServicesLoading(false);
      return;
    }

    let cancelled = false;

    const fetchServices = async () => {
      setServicesLoading(true);
      try {
        const result = await servicesApi.list(id);
        if (!cancelled && result.success) {
          setServices(result.services ?? []);
        }
      } catch (error) {
        console.error("Failed to load services for domain settings:", error);
      } finally {
        if (!cancelled) {
          setServicesLoading(false);
        }
      }
    };

    void fetchServices();

    return () => {
      cancelled = true;
    };
  }, [id, isServicesProject]);

  const handleSubmitDomains = async () => {
    const trimmedDomain = newDomain.trim();
    if (!trimmedDomain) return;

    setIsSubmitting(true);

    const result = await projectsApi.connectDomain(id, {
      domain: trimmedDomain,
      includeWww,
    });

    if (!result.success) {
      showToast(result.error || "Failed to connect domain", "error", result.message || "Failed to connect domain");
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
        showToast(result.message || result.error || "Failed to renew SSL certificate", "error", result.message);
      }
    } catch (error) {
      console.error("Failed to renew SSL:", error);
      showToast("Failed to renew SSL certificate", "error");
    } finally {
      setIsRenewingSSL(false);
    }
  };

  const projectLabel = projectData.slug || projectData.name || "project";

  const getServiceRouteSummary = (service: Service) => {
    if (!service.exposed) {
      return {
        connected: false,
        statusLabel: "Internal",
        statusClass: "bg-muted/60 text-muted-foreground/70",
        detail: "Not exposed",
        liveUrl: null as string | null,
      };
    }

    const liveUrl = service.domainType === "custom" && service.customDomain
      ? `https://${service.customDomain}`
      : `https://${resolveServiceHostnameLabel(projectLabel, service.name, service.domain)}.${baseDomain}`;

    return {
      connected: true,
      statusLabel: "Public",
      statusClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      detail: service.domainType === "custom" ? "Custom domain" : "Free subdomain",
      liveUrl,
    };
  };

  const sslStatusLabel = isLoadingSSL
    ? "Loading"
    : sslData?.status === "expired"
      ? "Expired"
      : sslData?.status === "expiring_soon"
        ? `Expiring in ${sslData?.daysUntilExpiry} days`
        : sslData?.enabled
          ? "Active"
          : "Inactive";

  const sslStatusTone = sslData?.status === "expired"
    ? "danger"
    : sslData?.status === "expiring_soon"
      ? "warning"
      : sslData?.enabled || isManagedHostDomain
        ? "success"
        : "neutral";

  return (
    <div className="space-y-5">
      {!isServicesProject && (
        <>
          <div className={`grid grid-cols-1 ${hasDomain ? "lg:grid-cols-2" : ""} gap-5`}>
            <SectionCard
              title={domainMeta.title}
              description={domainMeta.subtitle}
              icon={Globe}
              iconTone="primary"
              actions={(
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <ActionButton href={currentHref} label="Visit" icon={ExternalLink} />
                  <ActionButton
                    label={showCustomDomainSection ? "Hide setup" : "Add domain"}
                    icon={Plus}
                    onClick={() => setShowCustomDomainSection((value) => !value)}
                  />
                </div>
              )}
            >
              <ValueBlock label={hasDomain ? "Domain" : "Local URL"} value={currentUrl} mono />
              <InfoRow label="Type" value={domainMeta.typeLabel} />
              <InfoRow
                label="Status"
                value={<StatusPill tone={domainMeta.statusTone}>{domainMeta.statusLabel}</StatusPill>}
              />
              {hasDomain && (
                <InfoRow
                  label="SSL"
                  value={<span className="text-[13px] font-medium text-foreground">{isManagedHostDomain ? "Included by host" : "Managed per domain"}</span>}
                />
              )}
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
                <InfoRow label="Issuer" value={isManagedHostDomain ? "Managed by host" : sslData?.issuer || "Let's Encrypt"} />
                <InfoRow
                  label="Expires"
                  value={isManagedHostDomain ? "Included" : sslData?.expiresAt ? new Date(sslData.expiresAt).toLocaleDateString() : "N/A"}
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
                      <p className="text-[12px] text-muted-foreground">Also generate records for www.{newDomain || "yourdomain.com"}</p>
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
                      {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
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
                      <DnsRecordRow key={`${record.type}-${record.host}-${index}`} record={record} onCopy={handleCopy} />
                    ))
                  ) : (
                    <>
                      <DnsRecordPlaceholder
                        type={dnsMode === "selfhosted" ? "A" : "CNAME"}
                        host="@"
                        value={dnsMode === "selfhosted" ? "your server IP" : "target generated after connect"}
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
                  DNS changes can take up to 48 hours to propagate globally. Once the records resolve, verification and SSL provisioning will follow automatically.
                </div>
              </SectionCard>
            </div>
          )}
        </>
      )}

      {isServicesProject && (
        <SectionCard
          title="Service Routing"
          description={`${services.filter((s) => s.exposed).length} of ${services.length} services exposed publicly`}
          icon={Container}
          iconTone="primary"
        >
          {servicesLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading services...</div>
          ) : services.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No compose services found for this project.</div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/40 divide-y divide-border/30">
              {services.map((service) => {
                const route = getServiceRouteSummary(service);

                return (
                  <button
                    key={service.id}
                    onClick={() => router.push(`/projects/${id}/services/${service.id}`)}
                    className="flex w-full items-center gap-4 px-4 py-4 text-left transition-colors hover:bg-foreground/[0.025]"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-foreground">{service.name}</span>
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${route.statusClass}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${route.connected ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
                          {route.statusLabel}
                        </span>
                      </div>

                      {route.liveUrl ? (
                        <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <Link2 className="size-3" />
                          <span className="truncate">{route.liveUrl.replace("https://", "")}</span>
                          <span className="text-muted-foreground/50">·</span>
                          <span>Port {service.exposedPort || "Auto"}</span>
                          <span className="text-muted-foreground/50">·</span>
                          <span>{route.detail}</span>
                        </div>
                      ) : (
                        <p className="mt-1.5 text-[12px] text-muted-foreground">
                          Internal only — open the service to configure public routing.
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {route.liveUrl && (
                        <a
                          href={route.liveUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors"
                        >
                          <ExternalLink className="size-3" />
                          Open
                        </a>
                      )}
                      <ChevronRight className="size-4 text-muted-foreground/40" />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </SectionCard>
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
  actions,
  children,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  iconTone?: keyof typeof ICON_TONES;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
      <div className="border-b border-border/40 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ICON_TONES[iconTone]}`}>
            <Icon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
          </div>
        </div>
        {actions ? <div className="mt-4">{actions}</div> : null}
      </div>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </div>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div className="text-right">{typeof value === "string" ? <span className="text-[13px] font-medium text-foreground">{value}</span> : value}</div>
    </div>
  );
}

function ValueBlock({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-muted/25 px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">{label}</div>
      <div className={`mt-2 text-[14px] font-semibold text-foreground break-all ${mono ? "font-mono" : ""}`}>{value}</div>
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
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${styles}`}>
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
  const className = "inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-foreground/[0.06] px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:cursor-not-allowed disabled:opacity-50";

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
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">{record.type}</div>
          <div className="mt-1 text-[13px] font-medium text-foreground">{record.host}</div>
          <code className="mt-2 block break-all text-[12px] text-muted-foreground">{record.value || "—"}</code>
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
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">{type}</div>
      <div className="mt-1 text-[13px] font-medium text-foreground">{host}</div>
      <div className="mt-2 text-[12px] text-muted-foreground">{value}</div>
    </div>
  );
}