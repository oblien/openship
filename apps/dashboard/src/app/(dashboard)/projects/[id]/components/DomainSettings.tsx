"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  Globe,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { RoutingConfigCard } from "./RoutingConfigCard";
import { RouteRules } from "./RouteRules";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { getApiErrorMessage, projectsApi, deployApi, domainsApi, serviceKind, servicesApi, type Service, type ServiceInput } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";
import { usePlatform } from "@/context/PlatformContext";
import { resolveServiceHostnameLabel } from "@repo/core";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";
import { useEdgeModal } from "@/hooks/useSystemPrepareModal";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import {
  createPublicEndpoint,
  ensurePublicEndpoints,
  type PublicEndpoint,
  type PortCheckUI,
  type OutputCheckUI,
} from "@/context/deployment/types";

interface DnsRecord {
  type: "CNAME" | "A" | "TXT";
  host: string;
  /** Fully-qualified record name — always correct; shown as the fallback when
   *  the provider won't take the relative host (multi-part TLDs like co.uk). */
  name?: string;
  value: string;
}

type DomainTone = "success" | "warning" | "danger" | "neutral";

interface DomainSummaryItem {
  /** Unique key for React iteration — endpoint id OR hostname when no endpoint. */
  id: string;
  /**
   * Backing domain row id (`dom_...`). Required for POST /domains/:id/verify.
   * Undefined when the endpoint exists in publicEndpoints draft but the
   * corresponding domain row hasn't been persisted yet (pre-save state).
   */
  domainId?: string;
  title: string;
  hostname: string;
  typeLabel: string;
  mappedLabel: string;
  /** Numeric routed port + owning service id — used to match a live
   *  port-reachability check to this card. */
  mappedPort?: number;
  serviceId?: string;
  /** Routed path (static apps) — used to match a live static-output check. */
  targetPath?: string;
  liveUrl: string;
  isPrimary: boolean;
  /** True when the row exists in DB but verified=false / status=pending. */
  needsVerify: boolean;
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

function resolveDomainStatus(domain: any, t: Dictionary): { label: string; tone: DomainTone } {
  const s = t.projectSettings.domains.status;
  if (domain?.verified) {
    return { label: s.verified, tone: "success" };
  }

  switch (domain?.status) {
    case "active":
      return { label: s.active, tone: "success" };
    case "failed":
      return { label: s.failed, tone: "danger" };
    case "removing":
      return { label: s.removing, tone: "neutral" };
    default:
      return { label: s.pending, tone: "warning" };
  }
}

function resolveDomainSsl(hostname: string, domain: any, baseDomain: string, t: Dictionary): { label: string; tone: DomainTone } {
  const s = t.projectSettings.domains.ssl;
  if (hostname.endsWith(`.${baseDomain}`)) {
    return { label: s.includedByHost, tone: "success" };
  }

  switch (domain?.sslStatus) {
    case "active":
      // Operator-supplied cert (BYO / Origin CA) — flag it so the user knows
      // it won't auto-renew via certbot.
      return { label: domain?.manualSsl ? s.manual : s.active, tone: "success" };
    case "external":
      return { label: s.external, tone: "success" };
    case "provisioning":
      return { label: s.provisioning, tone: "warning" };
    case "expired":
      return { label: s.expired, tone: "danger" };
    case "error":
      return { label: s.error, tone: "danger" };
    default:
      return { label: s.inactive, tone: "neutral" };
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
    servicesData,
    refreshServices,
  } = useProjectSettings();
  const { showToast } = useToast();
  const { t } = useI18n();
  const router = useRouter();
  const { baseDomain, selfHosted } = usePlatform();
  const openEdgeModal = useEdgeModal();
  // Install/own OpenResty + apply routes reload-free (no redeploy), surfacing the
  // 80/443 takeover consent if a foreign proxy holds them. Reused by the first
  // route publish + the "Set up edge" action.
  const openEdge = useCallback(
    () => openEdgeModal(id, { onDone: () => { invalidateProjectCaches(id); router.refresh(); } }),
    [openEdgeModal, id, router],
  );

  const [newDomain, setNewDomain] = useState("");
  // Unified "add domain" = add a route: pick free/custom + the port it maps to.
  // Same model services use; single-app just gets a lighter form.
  const [newDomainType, setNewDomainType] = useState<"free" | "custom">("custom");
  const [newDomainPort, setNewDomainPort] = useState("");
  // Static apps route a custom domain to a deployment PATH (not a port). Default
  // "/", user-editable so one project can serve different paths per domain.
  const [newDomainPath, setNewDomainPath] = useState("/");
  const [showCustomDomainSection, setShowCustomDomainSection] = useState(false);
  const [includeWww, setIncludeWww] = useState(false);
  // TLS + ingress handled upstream (Cloudflare Tunnel / LB): verify via TXT
  // only, skip certbot, serve plain HTTP. The domain need not resolve to us.
  const [externalIngress, setExternalIngress] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Hostname of the row currently running its Renew action. Null when no
  // renew is in flight. Per-row so multi-domain projects can renew one
  // cert without blanking the button on every other row.
  const [renewingHostname, setRenewingHostname] = useState<string | null>(null);
  // Domain id currently running its read-only "Recheck SSL" action.
  const [recheckingDomainId, setRecheckingDomainId] = useState<string | null>(null);
  // Domain targeted by the "Upload certificate" modal (BYO / Origin CA), plus
  // the PEM inputs and in-flight flag. Null when the modal is closed.
  const [certUploadDomain, setCertUploadDomain] = useState<{ domainId: string; hostname: string } | null>(null);
  const [certPem, setCertPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const [isUploadingCert, setIsUploadingCert] = useState(false);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  // Live preview of the DNS records the user will need to apply, derived
  // from the hostname they're typing. For self-hosted projects the
  // records are fully deterministic (server's A record + HMAC-derived
  // TXT challenge) so we can render them BEFORE Connect — the user can
  // copy them into their DNS provider while we wait for them to commit
  // the row. For cloud projects, preview is skipped: the CNAME target
  // comes from Oblien, which requires a network round trip per keystroke,
  // so we keep the "Connect first" flow there.
  const [previewedRecords, setPreviewedRecords] = useState<DnsRecord[]>([]);
  // The domain row that the DNS Records panel below is currently showing
  // records for. Populated on successful connectDomain so the panel's
  // bottom CTA can re-run verify against the exact row the user just
  // created (instead of guessing by hostname).
  const [pendingVerifyDomain, setPendingVerifyDomain] = useState<{
    id: string;
    hostname: string;
  } | null>(null);
  const [editingRouteServiceId, setEditingRouteServiceId] = useState<string | null>(null);
  const [routeSavingServiceId, setRouteSavingServiceId] = useState<string | null>(null);
  // Local draft for the "Edit route" modal — the card edits this in memory; the
  // API is hit ONCE on Save (not on every toggle/keystroke).
  const [routeDraft, setRouteDraft] = useState<{
    exposed: boolean;
    domainType: "free" | "custom";
    domain: string;
    customDomain: string;
    exposedPort: string;
  } | null>(null);
  // "Add route" form (services projects): a generic domain → port entry. The
  // port is matched to the service that owns it; that service is then exposed.
  const [showAddRoute, setShowAddRoute] = useState(false);
  const [addRouteDraft, setAddRouteDraft] = useState<{
    domainType: "free" | "custom";
    domain: string;
    port: string;
  }>({ domainType: "free", domain: "", port: "" });
  const [addRouteError, setAddRouteError] = useState<string | null>(null);
  const [addRouteSaving, setAddRouteSaving] = useState(false);
  const [isSavingPublicEndpoints, setIsSavingPublicEndpoints] = useState(false);
  const [isEditingDomains, setIsEditingDomains] = useState(false);
  // Tracks the per-domain Verify button state. Holds the domainId of the
  // row currently running its verify check so the button can spin and
  // disable. Null when no verify is in flight.
  const [verifyingDomainId, setVerifyingDomainId] = useState<string | null>(null);
  // After a failed verify, remember which record(s) still aren't resolving so
  // the pending card can name them and auto-open its DNS records. Keyed by row.
  const [verifyFailure, setVerifyFailure] = useState<
    { domainId: string; cnameVerified: boolean; txtVerified: boolean } | null
  >(null);
  // Live port reachability of the active deployment (advisory) — drives the
  // per-card "nothing responded on port X" hint. [] = no signal → no hint.
  const [portChecks, setPortChecks] = useState<PortCheckUI[]>([]);
  // Static apps only: live "is there output at this path?" (advisory).
  const [outputChecks, setOutputChecks] = useState<OutputCheckUI[]>([]);
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
  const [settingPrimaryId, setSettingPrimaryId] = useState<string | null>(null);

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
      .map((endpoint: any, index: number): DomainSummaryItem | null => {
        const hostname = resolveProjectEndpointHostname(endpoint, baseDomain);
        if (!hostname) return null;

        const domain =
          (typeof endpoint?.id === "string" ? domainById.get(endpoint.id) : undefined) ||
          domainByHostname.get(hostname) ||
          null;
        const mappedPort = endpoint?.port !== undefined && endpoint?.port !== null
          ? String(endpoint.port)
          : projectRuntimePort;

        // domainId comes from the persisted domain row, NOT the endpoint
        // — the verify endpoint at POST /domains/:id/verify keys on the
        // dom_... row id. Without this, the Verify button has nothing to
        // call. needsVerify is true ONLY when the row exists in DB
        // (domain is non-null) AND verified is explicitly false.
        const domainId = typeof domain?.id === "string" ? domain.id : undefined;
        const needsVerify = !!domain && domain.verified === false;

        return {
          id: endpoint?.id || hostname,
          domainId,
          title: index === 0 ? t.projectSettings.domains.primaryDomainTitle : interpolate(t.projectSettings.domains.domainNTitle, { n: String(index + 1) }),
          hostname,
          typeLabel: endpoint?.domainType === "custom" ? t.projectSettings.domains.typeCustom : t.projectSettings.domains.typeFree,
          mappedLabel: hasProjectServer
            ? (mappedPort ? interpolate(t.projectSettings.domains.portLabel, { port: String(mappedPort) }) : t.projectSettings.domains.noPortSelected)
            : (endpoint?.targetPath || "/"),
          mappedPort: hasProjectServer ? (Number(mappedPort) || undefined) : undefined,
          targetPath: hasProjectServer ? undefined : (endpoint?.targetPath || "/"),
          liveUrl: `https://${hostname}`,
          isPrimary: index === 0,
          needsVerify,
          status: resolveDomainStatus(domain, t),
          ssl: resolveDomainSsl(hostname, domain, baseDomain, t),
        };
      })
      .filter((domain): domain is DomainSummaryItem => domain !== null);
  }, [projectData.publicEndpoints, publicEndpoints, domainsData.domains, baseDomain, hasProjectServer, projectRuntimePort, t]);

  const primaryProjectDomain = domainSummaries[0] ?? null;

  const primaryDomainName = primaryProjectDomain?.hostname || "";
  const localPort = projectData.port || projectData.options?.productionPort || 3000;
  const localUrl = `localhost:${localPort}`;
  const hasDomain = !!primaryDomainName;
  const currentUrl = hasDomain ? primaryDomainName : localUrl;
  const currentHref = hasDomain ? `https://${primaryDomainName}` : `http://${localUrl}`;
  const isManagedHostDomain = hasDomain && primaryDomainName.endsWith(`.${baseDomain}`);
  useEffect(() => {
    setPublicEndpoints(draftPublicEndpoints);
  }, [draftPublicEndpoints]);

  const domainMeta = useMemo(() => {
    const m = t.projectSettings.domains.meta;
    if (!hasDomain) {
      return {
        title: m.accessTitle,
        subtitle: m.accessSubtitle,
        typeLabel: m.local,
        statusLabel: m.availableOnMachine,
        statusTone: "neutral" as const,
      };
    }

    if (isManagedHostDomain) {
      return {
        title: m.primaryTitle,
        subtitle:
          domainSummaries.length > 1
            ? interpolate(m.primaryAcross, { count: String(domainSummaries.length) })
            : m.hostManaged,
        typeLabel: primaryProjectDomain?.typeLabel || t.projectSettings.domains.typeFree,
        statusLabel: primaryProjectDomain?.status.label || t.projectSettings.domains.status.verified,
        statusTone: primaryProjectDomain?.status.tone || ("success" as const),
      };
    }

    return {
      title: m.primaryTitle,
      subtitle:
        domainSummaries.length > 1
          ? interpolate(m.primaryAcross, { count: String(domainSummaries.length) })
          : m.customProduction,
      typeLabel: primaryProjectDomain?.typeLabel || t.projectSettings.domains.typeCustom,
      statusLabel: primaryProjectDomain?.status.label || t.projectSettings.domains.status.pending,
      statusTone: primaryProjectDomain?.status.tone || ("warning" as const),
    };
  }, [hasDomain, isManagedHostDomain, domainSummaries.length, primaryProjectDomain, t]);

  // The previous live SSL fetch (deployApi.sslStatus) only ran for the
  // primary domain — useless for multi-domain projects, redundant for
  // single-domain projects since `domain.sslStatus` on the row carries
  // the same info. Each DomainOverviewCard now reads ssl directly from
  // its own DB row via resolveDomainSsl(), so no per-page fetch is
  // needed and adding domains stays free of N extra HTTP calls.

  useEffect(() => {
    if (!editingRouteServiceId) return;
    if (!services.some((service) => service.id === editingRouteServiceId)) {
      setEditingRouteServiceId(null);
    }
  }, [editingRouteServiceId, services]);

  // Seed the edit-route draft once per open (keyed on the service id, NOT on
  // `services` — a background refresh must not clobber in-progress edits).
  useEffect(() => {
    const svc = services.find((s) => s.id === editingRouteServiceId);
    if (!svc) {
      setRouteDraft(null);
      return;
    }
    setRouteDraft({
      exposed: svc.exposed,
      domainType: svc.domainType === "custom" ? "custom" : "free",
      domain: svc.domain ?? "",
      customDomain: svc.customDomain ?? "",
      exposedPort: svc.exposedPort || firstContainerPort(svc.ports),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingRouteServiceId]);

  // Live-preview DNS records as the user types — self-hosted only.
  //
  // For a self-hosted API the verification text is fully deterministic:
  //   - A record points to env.SERVER_IP (no API call needed)
  //   - TXT challenge is HMAC(hostname, BETTER_AUTH_SECRET) — also no
  //     external call
  //
  // So we can show the records BEFORE the user clicks Connect — they
  // can copy them into their DNS provider, propagation starts ticking,
  // and Connect just commits the row to the DB. For cloud projects the
  // CNAME target comes from Oblien (one network call per keystroke),
  // so we keep the "Connect first" flow there to avoid hammering Oblien.
  //
  // Local validity guard mirrors the backend (addDomain): must have a
  // dot, not end with the managed suffix, not be an IP literal. We
  // skip preview for invalid input rather than firing a doomed request.
  useEffect(() => {
    // Only custom domains have records to preview — free subdomains are
    // host-managed (no DNS to apply).
    if (!showCustomDomainSection || !selfHosted || newDomainType !== "custom") {
      setPreviewedRecords([]);
      return;
    }
    const trimmed = newDomain.trim().toLowerCase();
    const baseLower = baseDomain.toLowerCase();
    const looksValid =
      trimmed.length > 0 &&
      trimmed.includes(".") &&
      !trimmed.startsWith(".") &&
      !trimmed.endsWith(".") &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(trimmed) &&
      trimmed !== baseLower &&
      !trimmed.endsWith(`.${baseLower}`);

    if (!looksValid) {
      setPreviewedRecords([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await domainsApi.previewRecords(trimmed);
        if (cancelled) return;
        if (result?.data?.records) {
          setPreviewedRecords(result.data.records);
        } else {
          setPreviewedRecords([]);
        }
      } catch {
        // Preview is best-effort — a failed lookup just hides the panel.
        // The user can still click Connect and see records via the
        // canonical /connect path's response.
        if (!cancelled) setPreviewedRecords([]);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [newDomain, newDomainType, selfHosted, showCustomDomainSection, baseDomain]);

  // Add a domain = add a ROUTE (the same model services use): pick free/custom,
  // the host, and the port (server) / path (static) it maps to. It lands in the
  // project's publicEndpoints so it shows in the list below and is fully
  // operable. Custom domains are created PENDING (backend: syncProjectPublicRoutes)
  // and must be DNS-verified before they go live; we surface their records +
  // Verify via the connect call, which returns the real domain-row id.
  const handleSubmitDomains = async () => {
    const host = newDomain.trim().toLowerCase();
    if (!host) return;
    const isCustom = newDomainType === "custom";
    const portValue = newDomainPort.trim();

    // The "Include www" toggle owns the www record — a hand-typed "www."
    // prefix would double it up, so block it with guidance instead.
    if (isCustom && host.startsWith("www.")) {
      showToast(t.projectSettings.domains.add.noWww, "error", t.projectSettings.domains.toast.addDomainTitle);
      return;
    }

    if (hasProjectServer) {
      const portNum = Number(portValue);
      if (!portValue || !Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
        showToast(t.projectSettings.domains.toast.enterPort, "error", t.projectSettings.domains.toast.addDomainTitle);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      // Custom: create the pending row + get its DNS records + real verify id
      // up front. persist (below) then attaches the port and lists it; the
      // backend keeps it pending until /verify.
      if (isCustom) {
        const result = await projectsApi.connectDomain(id, { domain: host, includeWww, externalIngress });
        if (!result.success) {
          showToast(
            result.error || t.projectSettings.domains.toast.addDomainFailed,
            "error",
            result.message || t.projectSettings.domains.toast.addDomainFailedTitle,
          );
          return;
        }
        if (result.records?.records) setDnsRecords(result.records.records);
        setPendingVerifyDomain(
          typeof result.domain?.id === "string"
            ? { id: result.domain.id, hostname: host }
            : null,
        );
      }

      const nextEndpoint = createPublicEndpoint({
        domainType: newDomainType,
        ...(isCustom ? { customDomain: host } : { domain: host }),
        ...(hasProjectServer ? { port: portValue } : { targetPath: newDomainPath.trim() || "/" }),
      });
      const label = isCustom ? host : `${host}.${baseDomain}`;
      const ok = await persistPublicEndpoints(
        [...publicEndpoints, nextEndpoint],
        isCustom
          ? interpolate(t.projectSettings.domains.toast.addedCustom, { label })
          : interpolate(t.projectSettings.domains.toast.addedFree, { label }),
      );
      if (!ok) return;

      // Reset the form. Keep the panel open for custom (DNS records + Verify);
      // free has nothing to verify, so collapse it.
      setNewDomain("");
      setNewDomainPort(projectRuntimePort);
      setNewDomainPath("/");
      setIncludeWww(false);
      setExternalIngress(false);
      if (!isCustom) {
        setShowCustomDomainSection(false);
        setDnsRecords([]);
        setPendingVerifyDomain(null);
      }
    } catch (err) {
      console.error("Failed to add domain:", err);
      showToast(getApiErrorMessage(err) || t.projectSettings.domains.toast.addDomainFailed, "error", t.projectSettings.domains.toast.addDomainFailedTitle);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopy = async (text: string) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    showToast(t.projectSettings.domains.toast.copied, "success");
  };

  const handleVerifyDomain = async (domainId: string, hostname: string) => {
    // Guard: ignore re-clicks while a verify is in flight for this row.
    if (verifyingDomainId) return;
    setVerifyingDomainId(domainId);

    try {
      const result = await domainsApi.verify(domainId);

      if (result.verified) {
        // Optimistically flip the local row so the Pending pill becomes
        // Verified without waiting for the next /info refetch. The next
        // invalidateProjectCaches below catches the canonical state
        // (including sslStatus transitions from the background provision).
        const updatedDomains = domainsData.domains.map((d) =>
          d.id === domainId
            ? { ...d, verified: true, status: "active", sslStatus: result.sslStatus ?? d.sslStatus }
            : d,
        );
        updateDomains(updatedDomains);
        setVerifyFailure((f) => (f?.domainId === domainId ? null : f));
        invalidateProjectCaches(id);
        showToast(
          result.message || interpolate(t.projectSettings.domains.toast.verifiedSuccess, { hostname }),
          "success",
          t.projectSettings.domains.toast.verifiedTitle,
        );
      } else {
        // 422 path. cnameVerified/txtVerified pinpoint what's still missing —
        // stash it so the pending card names the record + opens its DNS panel.
        setVerifyFailure({
          domainId,
          cnameVerified: !!result.cnameVerified,
          txtVerified: !!result.txtVerified,
        });
        showToast(
          result.message || interpolate(t.projectSettings.domains.toast.verifyNotYet, { hostname }),
          "error",
          t.projectSettings.domains.toast.verifyFailedTitle,
        );
      }
    } catch (err) {
      console.error("Failed to verify domain:", err);
      showToast(
        getApiErrorMessage(err) || t.projectSettings.domains.toast.verifyFailed,
        "error",
        t.projectSettings.domains.toast.verifyFailedTitle,
      );
    } finally {
      setVerifyingDomainId(null);
    }
  };

  // Human hint naming which DNS record still isn't resolving after a failed
  // verify — powers the pending card's inline message + auto-opens its records.
  const verifyHintFor = (domainId?: string): string | null => {
    if (!domainId || verifyFailure?.domainId !== domainId) return null;
    const vm = t.projectSettings.domains.verifyMissing;
    if (!verifyFailure.cnameVerified && !verifyFailure.txtVerified) return vm.both;
    if (!verifyFailure.cnameVerified) return vm.cname;
    if (!verifyFailure.txtVerified) return vm.txt;
    return null;
  };

  // Live port reachability, fetched once per project. Best-effort: a failure
  // just leaves the hints off (the probe itself never blocks or false-positives).
  useEffect(() => {
    let cancelled = false;
    deployApi
      .checkPorts(id)
      .then((res) => {
        if (!cancelled) setPortChecks(res.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setPortChecks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Match a live "not listening" check to a card — by service id (compose) or
  // routed port (single-app). Only a definitive checked result yields a hint.
  const portHintFor = (
    mappedPort?: number,
    serviceId?: string,
  ): { port: number; serviceName?: string } | null => {
    const match = portChecks.find(
      (c) =>
        c.checked &&
        !c.listening &&
        (serviceId ? c.serviceId === serviceId : c.serviceId == null && c.port === mappedPort),
    );
    return match ? { port: match.port, serviceName: match.serviceName } : null;
  };

  // Static-output reachability, fetched once per static project (server apps
  // use the port check instead). Best-effort: a failure just leaves hints off.
  useEffect(() => {
    if (hasProjectServer) {
      setOutputChecks([]);
      return;
    }
    let cancelled = false;
    deployApi
      .checkOutput(id)
      .then((res) => {
        if (!cancelled) setOutputChecks(res.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setOutputChecks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [id, hasProjectServer]);

  // Match a "no output found" check to a static card by routed path.
  const outputHintFor = (targetPath?: string): { path: string } | null => {
    if (!targetPath) return null;
    const match = outputChecks.find((c) => c.checked && !c.found && c.path === targetPath);
    return match ? { path: match.path } : null;
  };

  const handleRenewDomainSsl = async (hostname: string) => {
    // Guard: ignore re-clicks on the same row while a renew is in flight.
    if (renewingHostname) return;
    setRenewingHostname(hostname);
    try {
      const result = await deployApi.sslRenew(hostname, false);

      if (result.success) {
        showToast(interpolate(t.projectSettings.domains.toast.sslRenewed, { hostname }), "success");
        // Pull the canonical sslExpiresAt off the DB row by re-fetching
        // project info. The status pill flips on the next render.
        invalidateProjectCaches(id);
      } else {
        showToast(
          result.message || result.error || interpolate(t.projectSettings.domains.toast.sslRenewFailed, { hostname }),
          "error",
          result.message,
        );
      }
    } catch (error) {
      console.error("Failed to renew SSL:", error);
      // Surface the REAL server-side reason (e.g. "certbot: command not found",
      // ACME DNS/reachability errors) instead of a generic string — the API
      // returns it on the ApiError body and getApiErrorMessage walks it out.
      showToast(
        getApiErrorMessage(error, interpolate(t.projectSettings.domains.toast.sslRenewFailed, { hostname })),
        "error",
        t.projectSettings.domains.toast.sslTitle,
      );
    } finally {
      setRenewingHostname(null);
    }
  };

  // Read-only "is the cert actually issued + valid on the server?" check. No
  // certbot, no rate-limit cost. Recovers a row stuck on "Provisioning" once the
  // Let's Encrypt cert is in place, and confirms an existing cert after a deploy.
  const handleRecheckSsl = async (domainId: string, hostname: string) => {
    if (recheckingDomainId) return;
    setRecheckingDomainId(domainId);
    try {
      const res = await domainsApi.verifySsl(domainId);
      const status = res?.data?.sslStatus;
      if (status === "active") {
        showToast(interpolate(t.projectSettings.domains.toast.sslVerified, { hostname }), "success", t.projectSettings.domains.toast.sslTitle);
      } else {
        showToast(
          interpolate(t.projectSettings.domains.toast.sslNoCert, { hostname }),
          "error",
          t.projectSettings.domains.toast.sslTitle,
        );
      }
      invalidateProjectCaches(id);
    } catch (error) {
      console.error("Failed to recheck SSL:", error);
      showToast(getApiErrorMessage(error, interpolate(t.projectSettings.domains.toast.sslRecheckFailed, { hostname })), "error", t.projectSettings.domains.toast.sslTitle);
    } finally {
      setRecheckingDomainId(null);
    }
  };

  const handleUploadCert = async () => {
    if (!certUploadDomain || isUploadingCert) return;
    const { domainId, hostname } = certUploadDomain;
    if (!certPem.trim() || !keyPem.trim()) return;
    setIsUploadingCert(true);
    try {
      await domainsApi.uploadCertificate(domainId, { certPem: certPem.trim(), keyPem: keyPem.trim() });
      showToast(interpolate(t.projectSettings.domains.toast.certUploaded, { hostname }), "success", t.projectSettings.domains.toast.sslTitle);
      setCertUploadDomain(null);
      setCertPem("");
      setKeyPem("");
      invalidateProjectCaches(id);
    } catch (error) {
      console.error("Failed to upload certificate:", error);
      showToast(
        getApiErrorMessage(error, interpolate(t.projectSettings.domains.toast.certUploadFailed, { hostname })),
        "error",
        t.projectSettings.domains.toast.sslTitle,
      );
    } finally {
      setIsUploadingCert(false);
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

  // A project with a deployment but NO public route yet has no edge (OpenResty)
  // installed — e.g. a just-migrated image-only services stack, or an
  // internal-only stack deployed with no domains. OpenResty is only ever
  // ensured by a DEPLOY (the single routing-ensure pipe, and the only place the
  // edge-takeover consent modal can show). So adding the FIRST route must kick a
  // deploy; a normal already-routed project keeps the live best-effort apply
  // (no redeploy). Self-hosted only — cloud routes via the cloud edge.
  const isEdgeless = () =>
    selfHosted &&
    !!projectData.activeDeploymentId &&
    domainSummaries.length === 0 &&
    !services.some((s) => s.enabled && s.exposed);

  // First route on an edge-less project: instead of a full redeploy, open the
  // edge-consent flow — it installs/owns OpenResty on the project's server and
  // applies the routes reload-free (surfacing the SAME 80/443 takeover modal if
  // a foreign proxy holds them). No container rebuild, so a migrated attach-live
  // stack is never recreated. The route is already saved when this runs.
  const publishFirstRoute = async () => {
    openEdge();
  };

  // Persist a specific ordering of the project's public endpoints. Endpoint
  // ORDER is the source of truth for the primary domain (index 0 → primary),
  // so both "Save changes" (edit) and "Set as primary" (reorder) route through
  // here — keeping the index-based badge and the persisted isPrimary flag in
  // lockstep. Returns false (with a toast) if any endpoint is incomplete.
  const persistPublicEndpoints = async (
    endpoints: PublicEndpoint[],
    successMessage = t.projectSettings.domains.toast.routingUpdated,
  ): Promise<boolean> => {
    const wasEdgeless = isEdgeless();
    const payload = endpoints
      .map((endpoint) => buildPublicEndpointPayload(endpoint, hasProjectServer))
      .filter((endpoint): endpoint is NonNullable<ReturnType<typeof buildPublicEndpointPayload>> => endpoint !== null);

    if (payload.length !== endpoints.length || payload.length === 0) {
      showToast(t.projectSettings.domains.toast.completeEndpoints, "error", t.projectSettings.domains.toast.domainsTitle);
      return false;
    }

    const primaryPort = hasProjectServer && "port" in payload[0]
      ? payload[0].port
      : undefined;

    setIsSavingPublicEndpoints(true);
    try {
      await projectsApi.update(id, {
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
          (typeof domain?.id === "string" && domain.id === endpoints[index]?.id) ||
          domain?.hostname === hostname
        ));

        // Custom domains are pending until DNS-verified (matches the backend);
        // free/managed domains are host-verified immediately. Don't optimistically
        // flash a new custom domain as "Verified".
        const isCustom = endpoint.domainType === "custom";
        return {
          ...existing,
          id: existing?.id || endpoints[index]?.id || hostname,
          hostname,
          domain: hostname,
          primary: index === 0,
          isPrimary: index === 0,
          verified: existing?.verified ?? !isCustom,
          status: existing?.status ?? (isCustom ? "pending" : "active"),
          sslStatus: existing?.sslStatus ?? (endpoint.domainType === "free" ? "active" : "none"),
          targetPort: endpoint.port ?? null,
          targetPath: endpoint.targetPath ?? null,
          domainType: endpoint.domainType,
        };
      }));

      // Drop the cached project info so the next mount of Overview /
      // any hook consumer refetches with the new domain state.
      if (id) invalidateProjectCaches(id);
      showToast(successMessage, "success", t.projectSettings.domains.toast.domainsTitle);
      setIsEditingDomains(false);
      // First route on an edge-less project → deploy to install OpenResty + show
      // the takeover modal. Navigates away to the build screen.
      if (wasEdgeless) await publishFirstRoute();
      return true;
    } catch (error) {
      showToast(getApiErrorMessage(error, t.projectSettings.domains.toast.routingUpdateFailed), "error", t.projectSettings.domains.toast.domainsTitle);
      return false;
    } finally {
      setIsSavingPublicEndpoints(false);
    }
  };

  const handleSavePublicEndpoints = () => persistPublicEndpoints(publicEndpoints);

  // Make a project domain the primary one by moving its endpoint to index 0 and
  // persisting the new order (primary = first endpoint). Matches by domain-row
  // id, endpoint id, or resolved hostname so it works regardless of draft order.
  const handleSetPrimaryDomain = async (summary: DomainSummaryItem) => {
    if (summary.isPrimary) return;
    const idx = publicEndpoints.findIndex((ep) =>
      (!!summary.domainId && ep.id === summary.domainId) ||
      ep.id === summary.id ||
      resolveProjectEndpointHostname(ep, baseDomain)?.toLowerCase() === summary.hostname.toLowerCase(),
    );
    if (idx <= 0) return; // -1 = not found, 0 = already primary
    const reordered = [...publicEndpoints];
    const [chosen] = reordered.splice(idx, 1);
    reordered.unshift(chosen);
    setSettingPrimaryId(summary.id);
    try {
      setPublicEndpoints(reordered);
      await persistPublicEndpoints(reordered, t.projectSettings.domains.toast.primaryUpdated);
    } finally {
      setSettingPrimaryId(null);
    }
  };

  // Per-service domains have no endpoint order to reorder — primary is the
  // domain row's isPrimary flag. Flip it via the API, then reflect locally
  // (exactly one primary per project). getPrimaryByProject picks this up for
  // the project's canonical URL / favicon / analytics, and it survives
  // redeploys (service route registration preserves an existing isPrimary).
  const handleSetPrimaryServiceDomain = async (summary: DomainSummaryItem) => {
    if (!summary.domainId || summary.isPrimary) return;
    setSettingPrimaryId(summary.id);
    try {
      await domainsApi.setPrimary(summary.domainId);
      updateDomains(
        (Array.isArray(domainsData.domains) ? domainsData.domains : []).map((d: any) =>
          typeof d?.id === "string"
            ? { ...d, isPrimary: d.id === summary.domainId, primary: d.id === summary.domainId }
            : d,
        ),
      );
      if (id) invalidateProjectCaches(id);
      showToast(t.projectSettings.domains.toast.primaryUpdated, "success", t.projectSettings.domains.toast.domainsTitle);
    } catch (error) {
      showToast(getApiErrorMessage(error, t.projectSettings.domains.toast.setPrimaryFailed), "error", t.projectSettings.domains.toast.domainsTitle);
    } finally {
      setSettingPrimaryId(null);
    }
  };

  const projectLabel = projectData.slug || projectData.name || "project";

  const resolveServiceHostname = (service: Service) => {
    if (service.domainType === "custom" && service.customDomain) {
      return service.customDomain;
    }
    return `${resolveServiceHostnameLabel(projectLabel, service.name, service.domain, serviceKind(service))}.${baseDomain}`;
  };

  const getServiceRouteSummary = (service: Service) => {
    const liveUrl = service.exposed ? `https://${resolveServiceHostname(service)}` : null;

    if (!service.enabled) {
      return {
        connected: false,
        statusLabel: t.projectSettings.domains.route.disabled,
        statusClass: "bg-warning-bg text-warning",
        detail: service.exposed ? t.projectSettings.domains.route.routePaused : t.projectSettings.domains.route.serviceDisabled,
        liveUrl,
      };
    }

    if (!service.exposed) {
      return {
        connected: false,
        statusLabel: t.projectSettings.domains.route.internal,
        statusClass: "bg-muted/60 text-muted-foreground/70",
        detail: t.projectSettings.domains.route.notExposed,
        liveUrl: null as string | null,
      };
    }

    return {
      connected: true,
      statusLabel: t.projectSettings.domains.route.public,
      statusClass: "bg-success-bg text-success",
      detail: service.domainType === "custom" ? t.projectSettings.domains.typeCustom : t.projectSettings.domains.typeFree,
      liveUrl,
    };
  };

  const handleServiceRouteUpdate = async (
    serviceId: string,
    patch: Partial<ServiceInput>,
  ): Promise<boolean> => {
    const wasEdgeless = isEdgeless();
    setRouteSavingServiceId(serviceId);
    try {
      const result = await servicesApi.update(id, serviceId, patch);
      if (!result.success) {
        throw new Error("Failed to update service route");
      }
      await refreshServices();
      // First exposed route on an edge-less project → deploy to install
      // OpenResty + show the takeover modal (navigates to the build screen).
      if (wasEdgeless && patch.exposed) await publishFirstRoute();
      return true;
    } catch (error) {
      console.error("Failed to update service route:", error);
      showToast(t.projectSettings.domains.toast.routeUpdateFailed, "error");
      return false;
    } finally {
      setRouteSavingServiceId(null);
    }
  };

  // Match a free-form port to the enabled service that publishes it. Services
  // route per-service, so a "domain → port" route card attaches to whichever
  // service owns that port.
  const findServiceByPort = (port: string): Service | null => {
    const p = port.trim();
    if (!p) return null;
    return (
      services.find(
        (s) =>
          s.enabled &&
          (String(s.exposedPort ?? "") === p ||
            (s.ports ?? []).some((spec) => {
              const parts = spec.split(":");
              const container = (parts[parts.length - 1] ?? "").split("/")[0];
              const host = (parts[parts.length - 2] ?? "").split("/")[0];
              return container === p || host === p;
            })),
      ) ?? null
    );
  };

  const handleAddRoute = async () => {
    setAddRouteError(null);
    const { domainType, domain, port } = addRouteDraft;
    const cleanPort = port.trim();
    if (!cleanPort) {
      setAddRouteError(t.projectSettings.domains.toast.enterPortShort);
      return;
    }
    const target = findServiceByPort(cleanPort);
    if (!target) {
      setAddRouteError(interpolate(t.projectSettings.domains.toast.noServicePort, { port: cleanPort }));
      return;
    }
    const domainValue = domain.trim();
    if (!domainValue) {
      setAddRouteError(domainType === "custom" ? t.projectSettings.domains.toast.enterCustom : t.projectSettings.domains.toast.enterSubdomain);
      return;
    }
    setAddRouteSaving(true);
    try {
      await handleServiceRouteUpdate(target.id, {
        exposed: true,
        exposedPort: cleanPort,
        domainType,
        ...(domainType === "custom"
          ? { customDomain: domainValue.toLowerCase() }
          : { domain: domainValue.toLowerCase() }),
      });
      setShowAddRoute(false);
      setAddRouteDraft({ domainType: "free", domain: "", port: "" });
    } finally {
      setAddRouteSaving(false);
    }
  };

  // Every enabled + exposed service is a generic domain → port route card —
  // the SAME card a single-app project's endpoints render as. No project-vs-
  // service split in the UI; internal (non-exposed) services produce no card.
  const serviceRouteCards: Array<{ service: Service; summary: DomainSummaryItem }> = (() => {
    const domains = Array.isArray(domainsData.domains) ? domainsData.domains : [];
    const domainByHostname = new Map(
      domains
        .filter((d: any) => typeof d?.hostname === "string")
        .map((d: any) => [d.hostname.toLowerCase(), d]),
    );
    return services
      .filter((s) => s.enabled && s.exposed)
      .map((service) => {
        const hostname = resolveServiceHostname(service);
        const domain = domainByHostname.get(hostname.toLowerCase()) ?? null;
        return {
          service,
          summary: {
            id: service.id,
            domainId: typeof domain?.id === "string" ? domain.id : undefined,
            title: service.name,
            hostname,
            typeLabel: service.domainType === "custom" ? t.projectSettings.domains.typeCustom : t.projectSettings.domains.typeFree,
            mappedLabel: interpolate(t.projectSettings.domains.portLabel, { port: String(service.exposedPort || firstContainerPort(service.ports) || "auto") }),
            mappedPort: Number(service.exposedPort || firstContainerPort(service.ports)) || undefined,
            serviceId: service.id,
            liveUrl: `https://${hostname}`,
            isPrimary: domain?.isPrimary ?? false,
            needsVerify: !!domain && domain.verified === false,
            status: resolveDomainStatus(domain, t),
            ssl: resolveDomainSsl(hostname, domain, baseDomain, t),
          },
        };
      });
  })();

  // Build the ⋯ menu items for a domain card. Shared by the single-app and
  // service route cards so both collapse the same way. Visit is NOT here — it's
  // the card's header icon. `onEditRoute` adds the per-service "Edit route" item.
  const buildDomainMenuActions = (opts: {
    domain: DomainSummaryItem;
    isManagedRow: boolean;
    isRenewing: boolean;
    isRechecking: boolean;
    onEditRoute?: () => void;
    onSetPrimary?: () => void;
    isSettingPrimary?: boolean;
  }): MenuAction[] => {
    const { domain, isManagedRow, isRenewing, isRechecking, onEditRoute, onSetPrimary, isSettingPrimary } = opts;
    const m = t.projectSettings.domains.menu;
    const items: MenuAction[] = [];
    if (onEditRoute) {
      items.push({ id: "edit", label: m.editRoute, icon: <Pencil className="size-4" />, onClick: onEditRoute });
    }
    if (onSetPrimary) {
      items.push({
        id: "set-primary",
        label: isSettingPrimary ? m.settingPrimary : m.setPrimary,
        icon: <Star className={isSettingPrimary ? "size-4 animate-pulse" : "size-4"} />,
        onClick: onSetPrimary,
        disabled: isSettingPrimary,
      });
    }
    // Verify is NOT in this menu — pending cards render a direct inline Verify
    // button instead (see DomainOverviewCard), so it's never a scavenger hunt.
    if (!isManagedRow && !domain.needsVerify && domain.domainId) {
      items.push({
        id: "renew",
        label: isRenewing ? m.renewing : m.renewSsl,
        icon: <ShieldAlert className={isRenewing ? "size-4 animate-spin" : "size-4"} />,
        onClick: () => void handleRenewDomainSsl(domain.hostname),
        disabled: isRenewing,
      });
      items.push({
        id: "recheck",
        label: isRechecking ? m.rechecking : m.recheckSsl,
        icon: <RefreshCw className={isRechecking ? "size-4 animate-spin" : "size-4"} />,
        onClick: () => void handleRecheckSsl(domain.domainId!, domain.hostname),
        disabled: isRechecking,
      });
      items.push({
        id: "upload-cert",
        label: m.uploadCert,
        icon: <ShieldCheck className="size-4" />,
        onClick: () => setCertUploadDomain({ domainId: domain.domainId!, hostname: domain.hostname }),
      });
    }
    return items;
  };

  const editingRouteService =
    services.find((service) => service.id === editingRouteServiceId) ?? null;
  const editingRoute = editingRouteService ? getServiceRouteSummary(editingRouteService) : null;

  // Diff the edit-route draft against the service to enable Save + build the patch.
  const routeOriginalPort = editingRouteService
    ? editingRouteService.exposedPort || firstContainerPort(editingRouteService.ports)
    : "";
  const routeDirty = Boolean(
    editingRouteService &&
      routeDraft &&
      (routeDraft.exposed !== editingRouteService.exposed ||
        routeDraft.domainType !== (editingRouteService.domainType === "custom" ? "custom" : "free") ||
        routeDraft.domain !== (editingRouteService.domain ?? "") ||
        routeDraft.customDomain !== (editingRouteService.customDomain ?? "") ||
        routeDraft.exposedPort !== routeOriginalPort),
  );
  const routeSaving = editingRouteService ? routeSavingServiceId === editingRouteService.id : false;

  const handleSaveRoute = async () => {
    if (!editingRouteService || !routeDraft) return;
    const patch: Partial<ServiceInput> = {};
    if (routeDraft.exposed !== editingRouteService.exposed) patch.exposed = routeDraft.exposed;
    if (routeDraft.domainType !== (editingRouteService.domainType === "custom" ? "custom" : "free"))
      patch.domainType = routeDraft.domainType;
    if (routeDraft.domain !== (editingRouteService.domain ?? "")) patch.domain = routeDraft.domain;
    if (routeDraft.customDomain !== (editingRouteService.customDomain ?? ""))
      patch.customDomain = routeDraft.customDomain;
    if (routeDraft.exposedPort !== routeOriginalPort) patch.exposedPort = routeDraft.exposedPort;
    if (Object.keys(patch).length === 0) {
      setEditingRouteServiceId(null);
      return;
    }
    const ok = await handleServiceRouteUpdate(editingRouteService.id, patch);
    if (ok) setEditingRouteServiceId(null);
  };

  const hasMultipleProjectDomains = domainSummaries.length > 1;
  // Toggling "Hide setup" should also wipe in-flight connect/verify state
  // so reopening the panel starts fresh instead of resurrecting the
  // previous attempt's records and Verify button. Without this, a user
  // who closes the panel after connecting `acme.com`, then clicks Add
  // domain again, sees `acme.com`'s pending records — confusing.
  const handleToggleCustomDomain = () => {
    if (showCustomDomainSection) {
      setShowCustomDomainSection(false);
      setDnsRecords([]);
      setPreviewedRecords([]);
      setPendingVerifyDomain(null);
      setNewDomain("");
      setNewDomainType("custom");
      setNewDomainPort("");
      setIncludeWww(false);
    } else {
      // Seed the port with the project's runtime port — for a single-app
      // server every domain routes to the same process, so this is the
      // right default; the user can still change it.
      setNewDomainPort(projectRuntimePort);
      setShowCustomDomainSection(true);
    }
  };
  const singleDomainActions = (
    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
      <ActionButton href={currentHref} label={t.projectSettings.domains.actions.visit} icon={ExternalLink} />
      {hasProjectLevelRouting ? (
        <ActionButton label={t.projectSettings.domains.actions.editDomains} icon={Pencil} onClick={handleStartEditingDomains} />
      ) : null}
      <ActionButton
        label={showCustomDomainSection ? t.projectSettings.domains.actions.hideSetup : t.projectSettings.domains.actions.addDomain}
        icon={Plus}
        onClick={handleToggleCustomDomain}
      />
    </div>
  );
  const multiDomainActions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <ActionButton label={t.projectSettings.domains.actions.editDomains} icon={Pencil} onClick={handleStartEditingDomains} />
      <ActionButton
        label={showCustomDomainSection ? t.projectSettings.domains.actions.hideSetup : t.projectSettings.domains.actions.addDomain}
        icon={Plus}
        onClick={handleToggleCustomDomain}
      />
    </div>
  );

  // Whether the DNS Records panel is ready to render. Sources, in order:
  //   1. dnsRecords — real records from a completed Connect call (both modes)
  //   2. previewedRecords — live preview from /domains/preview (self-hosted only,
  //      derived from the hostname the user is typing)
  // Cloud users still see the panel only after Connect. Self-hosted users
  // see it the moment they type a plausible-looking domain, so they can
  // start applying records before committing the row.
  const recordsToShow = dnsRecords.length > 0 ? dnsRecords : previewedRecords;
  const hasDnsRecords = recordsToShow.length > 0;
  // True when the panel is showing preview (pre-Connect) data only. Used
  // to tweak the explainer text inside the panel.
  const isPreviewOnly = dnsRecords.length === 0 && previewedRecords.length > 0;
  // Custom domains must be entered bare; the "Include www" toggle adds the www
  // record. A typed "www." prefix is a mistake, so flag it and block submit.
  const newDomainHasWww =
    newDomainType === "custom" && newDomain.trim().toLowerCase().startsWith("www.");

  return (
    <div className="space-y-5">
      {domainsData.isLoading ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-2xl border border-border/50 bg-card p-5">
              <div className="h-4 w-32 animate-pulse rounded bg-muted/60" />
              <div className="mt-4 h-5 w-48 animate-pulse rounded bg-muted/50" />
              <div className="mt-4 space-y-2">
                <div className="h-3 w-full animate-pulse rounded bg-muted/40" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-muted/40" />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {!domainsData.isLoading && showCustomDomainSection ? (
        // Custom Domain setup sits ABOVE the existing list so the form
        // is the first thing the user sees after clicking Add domain —
        // they don't have to scroll past their existing domains to find
        // the input. DNS Records only appears next to the form once the
        // backend returns real records (post-Connect), so there's no
        // placeholder noise before the user has done anything.
        <div className={`grid grid-cols-1 gap-5 ${hasDnsRecords ? "lg:grid-cols-2" : ""}`}>
          <SectionCard
            title={t.projectSettings.domains.add.title}
            description={t.projectSettings.domains.add.description}
            icon={Plus}
            iconTone="blue"
          >
            <div className="space-y-4">
              {/* Route type — free (host-managed) vs custom (DNS-verified). */}
              <div className="flex items-center gap-2">
                {(["free", "custom"] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setNewDomainType(type)}
                    className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${
                      newDomainType === type
                        ? "bg-primary/10 text-primary ring-1 ring-primary/15"
                        : "bg-muted/40 text-muted-foreground hover:bg-muted/60"
                    }`}
                  >
                    {type === "free" ? t.projectSettings.domains.add.free : t.projectSettings.domains.add.custom}
                  </button>
                ))}
              </div>

              <div className="space-y-2">
                <label className="text-[13px] font-medium text-foreground">
                  {newDomainType === "custom" ? t.projectSettings.domains.add.domainName : t.projectSettings.domains.add.subdomain}
                </label>
                <div className="flex items-center overflow-hidden rounded-xl border border-border bg-background transition-colors focus-within:border-primary/40">
                  <input
                    placeholder={newDomainType === "custom" ? t.projectSettings.domains.add.customPlaceholder : projectLabel || t.projectSettings.domains.add.defaultAppName}
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                    className="flex-1 bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
                  />
                  {newDomainType === "free" && (
                    <span className="shrink-0 pe-4 text-sm text-muted-foreground">.{baseDomain}</span>
                  )}
                </div>
                {newDomainHasWww && (
                  <p className="text-xs text-danger">{t.projectSettings.domains.add.noWww}</p>
                )}
              </div>

              {hasProjectServer ? (
                <div className="space-y-2">
                  <label className="text-[13px] font-medium text-foreground">{t.projectSettings.domains.add.mapsToPort}</label>
                  <input
                    value={newDomainPort}
                    onChange={(e) => setNewDomainPort(e.target.value)}
                    placeholder={projectRuntimePort || "3000"}
                    inputMode="numeric"
                    className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="text-[13px] font-medium text-foreground">{t.projectSettings.domains.add.servesPath}</label>
                  <input
                    value={newDomainPath}
                    onChange={(e) => setNewDomainPath(e.target.value)}
                    placeholder="/"
                    className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40"
                  />
                  <p className="text-[12px] text-muted-foreground">{t.projectSettings.domains.add.servesPathHint}</p>
                  <p className="text-[12px] text-warning">{t.projectSettings.domains.add.servesPathRedeploy}</p>
                </div>
              )}

              {newDomainType === "custom" && (
                <div className="flex items-center justify-between gap-4 rounded-xl border border-border/50 bg-muted/25 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-foreground">{t.projectSettings.domains.add.includeWww}</p>
                    <p className="text-[12px] text-muted-foreground">
                      {interpolate(t.projectSettings.domains.add.includeWwwDesc, { domain: newDomain || t.projectSettings.domains.add.includeWwwFallback })}
                    </p>
                  </div>
                  <button
                    onClick={() => setIncludeWww((value) => !value)}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${includeWww ? "bg-primary" : "bg-muted"}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${includeWww ? "translate-x-6" : "translate-x-1"}`}
                    />
                  </button>
                </div>
              )}

              {newDomainType === "custom" && (
                <div className="flex items-center justify-between gap-4 rounded-xl border border-border/50 bg-muted/25 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-foreground">{t.projectSettings.domains.add.externalIngress}</p>
                    <p className="text-[12px] text-muted-foreground">
                      {t.projectSettings.domains.add.externalIngressDesc}
                    </p>
                  </div>
                  <button
                    onClick={() => setExternalIngress((value) => !value)}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${externalIngress ? "bg-primary" : "bg-muted"}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${externalIngress ? "translate-x-6" : "translate-x-1"}`}
                    />
                  </button>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  onClick={handleSubmitDomains}
                  disabled={
                    !newDomain.trim() ||
                    (hasProjectServer && !newDomainPort.trim()) ||
                    isSubmitting ||
                    newDomainHasWww
                  }
                  className="inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  {isSubmitting ? t.projectSettings.domains.add.adding : t.projectSettings.domains.add.submit}
                </button>
              </div>
            </div>
          </SectionCard>

          {hasDnsRecords ? (
            <SectionCard
              title={t.projectSettings.domains.dns.title}
              description={
                isPreviewOnly
                  ? t.projectSettings.domains.dns.descPreview
                  : t.projectSettings.domains.dns.descApply
              }
              icon={Link2}
              iconTone="orange"
            >
              <div className="space-y-3">
                {recordsToShow.map((record, index) => (
                  <DnsRecordRow
                    key={`${record.type}-${record.host}-${index}`}
                    record={record}
                    onCopy={handleCopy}
                  />
                ))}
              </div>

              <div className="rounded-xl bg-muted/35 px-4 py-3 text-[12px] text-muted-foreground">
                {isPreviewOnly
                  ? t.projectSettings.domains.dns.infoPreview
                  : t.projectSettings.domains.dns.infoApply}
              </div>

              {pendingVerifyDomain ? (
                <div className="flex justify-end pt-1">
                  <ActionButton
                    label={
                      verifyingDomainId === pendingVerifyDomain.id
                        ? t.projectSettings.domains.dns.verifying
                        : interpolate(t.projectSettings.domains.dns.verify, { hostname: pendingVerifyDomain.hostname })
                    }
                    icon={verifyingDomainId === pendingVerifyDomain.id ? Loader2 : RefreshCw}
                    onClick={() =>
                      void handleVerifyDomain(pendingVerifyDomain.id, pendingVerifyDomain.hostname)
                    }
                    disabled={verifyingDomainId === pendingVerifyDomain.id}
                  />
                </div>
              ) : null}
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {!isEditingDomains && !hasDomain && !domainsData.isLoading ? (
        // No domain attached yet — show the local URL as the access point
        // alongside the Add domain CTA. This is the cold-start state; once
        // any domain (free or custom) is attached, we render the list below.
        <SectionCard
          title={domainMeta.title}
          description={domainMeta.subtitle}
          icon={Globe}
          iconTone="primary"
          actions={singleDomainActions}
        >
          <ValueBlock label={t.projectSettings.domains.cold.localUrl} value={currentUrl} />
          <InfoRow label={t.projectSettings.domains.cold.type} value={domainMeta.typeLabel} />
          <InfoRow
            label={t.projectSettings.domains.cold.status}
            value={<StatusPill tone={domainMeta.statusTone}>{domainMeta.statusLabel}</StatusPill>}
          />
        </SectionCard>
      ) : null}

      {!isEditingDomains && hasDomain && hasProjectLevelRouting ? (
        // Project-level routing (single app / project endpoints): every domain
        // attached to the project, free OR custom, gets a route card. Services
        // projects route per-service and render their own cards below instead —
        // no auto project "primary" domain for them.
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {hasMultipleProjectDomains ? multiDomainActions : singleDomainActions}
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {domainSummaries.map((domain) => {
              // Pending custom domains get a Verify button right next to
              // their Pending status pill so the toast's "click Verify"
              // instruction isn't a scavenger hunt. Verified rows just
              // get the Visit action. We never render Verify without a
              // domainId — without it the API call has no row to verify
              // (e.g. pre-save endpoint drafts).
              // Secondary actions collapse into the card's ⋯ menu (Visit is the
              // header icon). Verify shows on pending rows; Renew/Recheck SSL on
              // verified custom rows only (free .opsh.io is host-managed).
              const isVerifying = !!verifyingDomainId && verifyingDomainId === domain.domainId;
              const isManagedRow = domain.hostname.toLowerCase().endsWith(`.${baseDomain}`);
              const isRenewing = renewingHostname === domain.hostname;
              const isRechecking = recheckingDomainId === domain.domainId;
              const canVerify = domain.needsVerify && !!domain.domainId;
              const menuActions = buildDomainMenuActions({
                domain,
                isManagedRow,
                isRenewing,
                isRechecking,
                // Reassigning primary only makes sense with >1 project domain.
                onSetPrimary:
                  hasMultipleProjectDomains && !domain.isPrimary
                    ? () => void handleSetPrimaryDomain(domain)
                    : undefined,
                isSettingPrimary: settingPrimaryId === domain.id,
              });
              return (
                <DomainOverviewCard
                  key={domain.id}
                  domain={domain}
                  menuActions={menuActions}
                  onVerify={canVerify ? () => void handleVerifyDomain(domain.domainId!, domain.hostname) : undefined}
                  verifying={isVerifying}
                  verifyHint={verifyHintFor(domain.domainId)}
                  autoOpenRecords={!!domain.domainId && verifyFailure?.domainId === domain.domainId}
                  loadRecords={canVerify ? () => domainsApi.records(domain.domainId!).then((r) => r.data.records) : undefined}
                  onCopy={handleCopy}
                  portHint={portHintFor(domain.mappedPort, domain.serviceId)}
                  outputHint={outputHintFor(domain.targetPath)}
                />
              );
            })}
          </div>
        </div>
      ) : null}

      {hasProjectLevelRouting && isEditingDomains ? (
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-[14px] font-semibold text-foreground">{t.projectSettings.domains.edit.title}</h3>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {hasProjectServer
                  ? t.projectSettings.domains.edit.descServer
                  : t.projectSettings.domains.edit.descStatic}
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
                {t.projectSettings.domains.edit.cancel}
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
                {isSavingPublicEndpoints ? t.projectSettings.domains.edit.saving : t.projectSettings.domains.edit.save}
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

      {!hasProjectLevelRouting && (servicesLoading || services.length > 0) && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Migrated/edgeless stacks: routes may be recorded but the server's
                edge (OpenResty on 80/443) isn't set up yet. This installs/owns it
                + applies routes reload-free (no redeploy), surfacing the takeover
                consent if a foreign proxy holds 80/443. Idempotent when the edge
                is already ours. */}
            {selfHosted && !!projectData.activeDeploymentId && services.some((s) => s.enabled && s.exposed) && (
              <ActionButton
                label="Set up edge"
                icon={ShieldCheck}
                onClick={openEdge}
              />
            )}
            <ActionButton
              label={showAddRoute ? t.projectSettings.domains.addRoute.cancel : t.projectSettings.domains.addRoute.add}
              icon={Plus}
              onClick={() => {
                setAddRouteError(null);
                setShowAddRoute((v) => !v);
              }}
            />
          </div>
          {showAddRoute && (
            <div className="mb-4 space-y-3 rounded-xl border border-border/50 bg-muted/20 p-4">
              <div className="flex items-center gap-2">
                {(["free", "custom"] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setAddRouteDraft((d) => ({ ...d, domainType: type }))}
                    className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${
                      addRouteDraft.domainType === type
                        ? "bg-primary/10 text-primary ring-1 ring-primary/15"
                        : "bg-muted/40 text-muted-foreground hover:bg-muted/60"
                    }`}
                  >
                    {type === "free" ? t.projectSettings.domains.addRoute.free : t.projectSettings.domains.addRoute.custom}
                  </button>
                ))}
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="flex flex-1 items-center overflow-hidden rounded-xl border border-border/50 bg-background">
                  <input
                    value={addRouteDraft.domain}
                    onChange={(e) => setAddRouteDraft((d) => ({ ...d, domain: e.target.value }))}
                    placeholder={addRouteDraft.domainType === "custom" ? t.projectSettings.domains.addRoute.customPlaceholder : projectLabel || t.projectSettings.domains.addRoute.defaultServiceName}
                    className="flex-1 bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
                  />
                  {addRouteDraft.domainType === "free" && (
                    <span className="shrink-0 pe-3 text-sm text-muted-foreground">.{baseDomain}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-muted-foreground">{t.projectSettings.domains.addRoute.port}</span>
                  <input
                    value={addRouteDraft.port}
                    onChange={(e) => setAddRouteDraft((d) => ({ ...d, port: e.target.value }))}
                    placeholder={t.projectSettings.domains.addRoute.portPlaceholder}
                    inputMode="numeric"
                    className="w-24 rounded-xl border border-border/50 bg-background px-3 py-2.5 text-sm text-foreground outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleAddRoute()}
                    disabled={addRouteSaving}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
                  >
                    {addRouteSaving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                    {t.projectSettings.domains.addRoute.submit}
                  </button>
                </div>
              </div>
              {addRouteError && <p className="text-[12px] text-destructive">{addRouteError}</p>}
            </div>
          )}

          {servicesLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{t.projectSettings.domains.addRoute.loading}</div>
          ) : serviceRouteCards.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {t.projectSettings.domains.addRoute.emptyPrefix}<span className="font-medium text-foreground">{t.projectSettings.domains.addRoute.emptyAction}</span>{t.projectSettings.domains.addRoute.emptySuffix}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {serviceRouteCards.map(({ service, summary }) => {
                const isVerifying = !!verifyingDomainId && verifyingDomainId === summary.domainId;
                const canVerify = summary.needsVerify && !!summary.domainId;
                const menuActions = buildDomainMenuActions({
                  domain: summary,
                  isManagedRow: summary.hostname.toLowerCase().endsWith(`.${baseDomain}`),
                  isRenewing: renewingHostname === summary.hostname,
                  isRechecking: recheckingDomainId === summary.domainId,
                  onEditRoute: () => setEditingRouteServiceId(service.id),
                  // Choosing a canonical domain only makes sense with >1 route.
                  onSetPrimary:
                    serviceRouteCards.length > 1 && summary.domainId && !summary.isPrimary
                      ? () => void handleSetPrimaryServiceDomain(summary)
                      : undefined,
                  isSettingPrimary: settingPrimaryId === summary.id,
                });
                return (
                  <DomainOverviewCard
                    key={summary.id}
                    domain={summary}
                    menuActions={menuActions}
                    onVerify={canVerify ? () => void handleVerifyDomain(summary.domainId!, summary.hostname) : undefined}
                    verifying={isVerifying}
                    verifyHint={verifyHintFor(summary.domainId)}
                    autoOpenRecords={!!summary.domainId && verifyFailure?.domainId === summary.domainId}
                    loadRecords={canVerify ? () => domainsApi.records(summary.domainId!).then((r) => r.data.records) : undefined}
                    onCopy={handleCopy}
                    portHint={portHintFor(summary.mappedPort, summary.serviceId)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Routing (rewrites/redirects/headers) — advanced, sits AFTER the
          domain/route cards so the primary domain list leads the page. */}
      <RoutingConfigCard
        id={id}
        initial={projectData.routingConfig}
        onSaved={(cfg) => setProjectData((prev) => ({ ...prev, routingConfig: cfg }))}
      />

      {/* Edge security rules (rate-limit / ban / geo / hotlink) — a distinct
          feature from the routing config above, but the same kind of edge
          concern, so it sits right here, collapsed by default. Moved out of the
          Advanced tab. */}
      <RouteRules />

      {editingRouteService && editingRoute && routeDraft && (
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
                <h3 className="text-[14px] font-semibold text-foreground">{t.projectSettings.domains.editRoute.title}</h3>
                <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  {editingRouteService.name}
                  {editingRoute.liveUrl
                    ? ` · ${editingRoute.liveUrl.replace("https://", "")}`
                    : ` · ${t.projectSettings.domains.editRoute.internalOnly}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingRouteServiceId(null)}
                className="inline-flex min-h-9 items-center rounded-xl bg-foreground/[0.06] px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
              >
                {t.projectSettings.domains.editRoute.close}
              </button>
            </div>

            <div className="px-5 py-5">
              <RoutingSettingsCard
                projectName={projectLabel}
                domain={routeDraft.domain}
                customDomain={routeDraft.customDomain}
                domainType={routeDraft.domainType}
                exposed={routeDraft.exposed}
                ports={editingRouteService.ports}
                exposedPort={routeDraft.exposedPort}
                disabled={routeSaving}
                liveUrl={editingRoute.connected ? editingRoute.liveUrl : null}
                // The card edits the in-memory draft only — the API is hit ONCE
                // on Save. saveMode="change" reports each edit straight to state
                // (no per-keystroke/per-toggle request, no inline pill).
                onExposedChange={(value) => setRouteDraft((prev) => (prev ? { ...prev, exposed: value } : prev))}
                onDomainTypeChange={(value) => setRouteDraft((prev) => (prev ? { ...prev, domainType: value } : prev))}
                onDomainChange={(value) => setRouteDraft((prev) => (prev ? { ...prev, domain: value } : prev))}
                onCustomDomainChange={(value) => setRouteDraft((prev) => (prev ? { ...prev, customDomain: value } : prev))}
                onExposedPortChange={(value) => setRouteDraft((prev) => (prev ? { ...prev, exposedPort: value } : prev))}
                saveMode="change"
              />
              {!editingRouteService.enabled && routeDraft.exposed && (
                <p className="mt-3 text-xs text-warning">
                  {t.projectSettings.domains.editRoute.disabledWarning}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end border-t border-border/40 px-5 py-4">
              <button
                type="button"
                onClick={handleSaveRoute}
                disabled={!routeDirty || routeSaving}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-primary px-4 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {routeSaving && <Loader2 className="size-3.5 animate-spin" />}
                {t.projectSettings.domains.editRoute.save}
              </button>
            </div>
          </div>
        </div>
      )}

      {certUploadDomain && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
          onClick={() => !isUploadingCert && setCertUploadDomain(null)}
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-2xl border border-border/60 bg-card shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-4">
              <div className="min-w-0">
                <h3 className="text-[14px] font-semibold text-foreground">{t.projectSettings.domains.certUpload.title}</h3>
                <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{certUploadDomain.hostname}</p>
              </div>
              <button
                type="button"
                onClick={() => setCertUploadDomain(null)}
                disabled={isUploadingCert}
                className="inline-flex min-h-9 items-center rounded-xl bg-foreground/[0.06] px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:opacity-50"
              >
                {t.projectSettings.domains.certUpload.close}
              </button>
            </div>

            <div className="space-y-4 px-5 py-5">
              <p className="text-[12px] text-muted-foreground">{t.projectSettings.domains.certUpload.desc}</p>
              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-foreground">{t.projectSettings.domains.certUpload.certLabel}</label>
                <textarea
                  value={certPem}
                  onChange={(event) => setCertPem(event.target.value)}
                  placeholder={t.projectSettings.domains.certUpload.certPlaceholder}
                  spellCheck={false}
                  rows={6}
                  className="w-full resize-y rounded-xl border border-border/60 bg-background px-3 py-2 font-mono text-[12px] text-foreground outline-none focus:border-primary"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-foreground">{t.projectSettings.domains.certUpload.keyLabel}</label>
                <textarea
                  value={keyPem}
                  onChange={(event) => setKeyPem(event.target.value)}
                  placeholder={t.projectSettings.domains.certUpload.keyPlaceholder}
                  spellCheck={false}
                  rows={6}
                  className="w-full resize-y rounded-xl border border-border/60 bg-background px-3 py-2 font-mono text-[12px] text-foreground outline-none focus:border-primary"
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void handleUploadCert()}
                  disabled={isUploadingCert || !certPem.trim() || !keyPem.trim()}
                  className="inline-flex min-h-9 items-center gap-2 rounded-xl bg-primary px-4 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {isUploadingCert && <Loader2 className="size-4 animate-spin" />}
                  {isUploadingCert ? t.projectSettings.domains.certUpload.submitting : t.projectSettings.domains.certUpload.submit}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  emerald: "bg-success-bg text-success",
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
    <div className="rounded-2xl border border-border/50 bg-card sadwq">
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
      <div className="text-end">
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
    success: "bg-success-bg text-success",
    warning: "bg-warning-bg text-warning",
    danger: "bg-danger-bg text-danger",
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
  spinning,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Animate the icon (use with a Loader2 icon for in-flight actions). */
  spinning?: boolean;
}) {
  const className =
    "inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-foreground/[0.06] px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:cursor-not-allowed disabled:opacity-50";
  const iconClassName = spinning ? "size-3.5 animate-spin" : "size-3.5";

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        <Icon className={iconClassName} />
        {label}
      </a>
    );
  }

  return (
    <button onClick={onClick} disabled={disabled} className={className}>
      <Icon className={iconClassName} />
      {label}
    </button>
  );
}

/** Container port from the first compose `ports` mapping: "8080:80" → "80",
 *  "80" → "80", "80/tcp" → "80". Mirrors RoutingSettingsCard's portOptions so
 *  the edit-route field pre-fills the same value the datalist suggests. */
function firstContainerPort(ports?: string[] | null): string {
  const first = (ports ?? [])[0];
  if (!first) return "";
  const parts = first.split(":");
  return (parts.length === 2 ? parts[1] : parts[0]).split("/")[0];
}

function DomainOverviewCard({
  domain,
  menuActions = [],
  onVerify,
  verifying = false,
  verifyHint,
  loadRecords,
  onCopy,
  autoOpenRecords = false,
  portHint,
  outputHint,
}: {
  domain: DomainSummaryItem;
  /** Secondary actions (edit, renew, …) collapsed into a ⋯ menu. Visit is a
   *  plain icon; Verify is a direct inline button below, not a menu item. */
  menuActions?: MenuAction[];
  onVerify?: () => void;
  verifying?: boolean;
  /** Message naming the DNS record that still isn't resolving after a fail. */
  verifyHint?: string | null;
  /** Lazy-fetch the DNS records for this row (pending custom domains only). */
  loadRecords?: () => Promise<DnsRecord[]>;
  onCopy?: (text: string) => void | Promise<void>;
  /** Open the records section immediately (used right after a failed verify). */
  autoOpenRecords?: boolean;
  /** Live port-reachability advisory ("nothing responded on port X"). */
  portHint?: { port: number; serviceName?: string } | null;
  /** Live static-output advisory ("no build output found at this path"). */
  outputHint?: { path: string } | null;
}) {
  const { t } = useI18n();
  const d = t.projectSettings.domains;
  const canVerify = domain.needsVerify && !!domain.domainId;
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [records, setRecords] = useState<DnsRecord[] | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);

  const openRecords = useCallback(async () => {
    setRecordsOpen(true);
    if (records !== null || !loadRecords) return;
    setRecordsLoading(true);
    try {
      setRecords(await loadRecords());
    } catch {
      setRecords([]);
    } finally {
      setRecordsLoading(false);
    }
  }, [records, loadRecords]);

  // A just-failed verify opens the records so the fix is right there.
  useEffect(() => {
    if (autoOpenRecords) void openRecords();
  }, [autoOpenRecords, openRecords]);

  return (
    <div className="rounded-2xl border border-border/50 bg-card sadwq">
      <div className="flex items-start justify-between gap-2 border-b border-border/40 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-semibold text-foreground">{domain.title}</h3>
            {domain.isPrimary ? (
              <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
                {d.overview.primary}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">{domain.typeLabel}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {domain.liveUrl ? (
            <a
              href={domain.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={d.overview.visit}
              aria-label={d.overview.visit}
              className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="size-4" />
            </a>
          ) : null}
          {menuActions.length > 0 ? <DropdownMenu actions={menuActions} align="right" /> : null}
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        <div className="break-all text-[15px] font-semibold text-foreground">{domain.hostname}</div>
        <InfoRow label={d.overview.mappedTo} value={domain.mappedLabel} />
        <InfoRow label={d.overview.status} value={<StatusPill tone={domain.status.tone}>{domain.status.label}</StatusPill>} />
        <InfoRow label={d.overview.ssl} value={<StatusPill tone={domain.ssl.tone}>{domain.ssl.label}</StatusPill>} />

        {portHint ? (
          <div className="flex items-start gap-2 rounded-xl border border-warning-border bg-warning-bg/40 px-3 py-2.5 text-[12px] text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {portHint.serviceName
                ? interpolate(d.portHint.bodyService, { service: portHint.serviceName, port: String(portHint.port) })
                : interpolate(d.portHint.body, { port: String(portHint.port) })}
            </span>
          </div>
        ) : null}

        {outputHint ? (
          <div className="flex items-start gap-2 rounded-xl border border-warning-border bg-warning-bg/40 px-3 py-2.5 text-[12px] text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{interpolate(d.outputHint.body, { path: outputHint.path })}</span>
          </div>
        ) : null}

        {canVerify ? (
          <div className="space-y-3 border-t border-border/40 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onVerify}
                disabled={verifying}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-primary px-3.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {verifying ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                {verifying ? d.menu.verifying : d.menu.verify}
              </button>
              {loadRecords ? (
                <button
                  type="button"
                  onClick={() => (recordsOpen ? setRecordsOpen(false) : void openRecords())}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-foreground/[0.06] px-3.5 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
                >
                  <Link2 className="size-3.5" />
                  {d.records.toggle}
                  <ChevronDown className={`size-3.5 transition-transform ${recordsOpen ? "rotate-180" : ""}`} />
                </button>
              ) : null}
            </div>

            {verifyHint ? <p className="text-[12px] text-warning">{verifyHint}</p> : null}

            {recordsOpen ? (
              <div className="space-y-2">
                <p className="text-[12px] text-muted-foreground">{d.records.hint}</p>
                {recordsLoading ? (
                  <div className="flex items-center gap-2 py-2 text-[12px] text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> {d.records.loading}
                  </div>
                ) : records && records.length > 0 ? (
                  records.map((record, i) => (
                    <DnsRecordRow
                      key={`${record.type}-${record.host}-${i}`}
                      record={record}
                      onCopy={onCopy ?? (() => {})}
                    />
                  ))
                ) : (
                  <p className="py-2 text-[12px] text-muted-foreground">{d.records.none}</p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
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
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
            {record.type}
          </div>
          <div className="mt-1 text-[13px] font-medium text-foreground">{record.host}</div>
          {record.name && record.name !== record.host ? (
            <code className="mt-0.5 block break-all text-[11px] text-muted-foreground/70">
              {record.name}
            </code>
          ) : null}
          <code className="mt-2 block break-all text-[12px] text-muted-foreground">
            {record.value || "-"}
          </code>
        </div>
        {record.value ? (
          <button
            onClick={() => onCopy(record.value)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            title={t.projectSettings.domains.dns.copy}
          >
            <Copy className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

