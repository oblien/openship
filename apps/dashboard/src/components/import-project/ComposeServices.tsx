"use client";

import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  Layers,
  Boxes,
  Globe,
  Lock,
  KeyRound,
  Code2,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Settings2,
  Network,
  HardDrive,
  AlertTriangle,
  X,
} from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import { folderApi } from "@/lib/api/folder";
import { usePlatform } from "@/context/PlatformContext";
import {
  usesServiceDeployment,
  ensurePublicEndpoints,
  type ComposeServiceInfo,
  type PublicEndpoint,
} from "@/context/deployment/types";
import { getModeSwitchUpdates } from "@/context/deployment/mode-config";
import { normalizeSubdomain } from "@/utils/subdomain";
import { parseContainerPort, serviceExposedPort } from "@/utils/compose-ports";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import { Modal } from "@/components/ui/Modal";
import DropdownMenu from "@/components/ui/DropdownMenu";
import EnvironmentVariables from "./EnvironmentVariables";
import BuildSettings from "./BuildSettings";
import { cn } from "@/lib/utils";
import { useI18n, interpolate } from "@/components/i18n-provider";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type EnvVarRow = { key: string; value: string; visible: boolean };

/** Convert Record<string,string> ↔ Array<{key,value,visible}> */
const envToArray = (
  env: Record<string, string>,
  visibleByKey: Record<string, boolean> = {},
  meta?: ComposeServiceInfo["environmentMeta"],
) =>
  Object.entries(env).map(([key, value]) => {
    const parsed = meta?.[key];
    const fallbackVisible = parsed?.source === "default" && value === parsed.resolvedValue;
    return { key, value, visible: visibleByKey[key] ?? fallbackVisible };
  });

const arrayToEnv = (arr: Array<{ key: string; value: string }>) => {
  const env: Record<string, string> = {};
  for (const { key, value } of arr) {
    if (key) env[key] = value;
  }
  return env;
};

const visibilityByKey = (arr: EnvVarRow[]) => {
  const visible: Record<string, boolean> = {};
  for (const env of arr) {
    if (env.key) visible[env.key] = env.visible;
  }
  return visible;
};

const envRecordsEqual = (a: Record<string, string>, b: Record<string, string>) => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
};

const missingEnvCount = (service: ComposeServiceInfo) =>
  Object.entries(service.environmentMeta ?? {}).filter(
    ([key, meta]) => meta.source === "missing" && !service.environment[key],
  ).length;

const portDisplay = (port: string) => parseContainerPort(port) || port;

// ─── Port / volume rows (compose string[] ↔ editable rows) ───────────────────
// Round-trips are LOSSLESS for the fields the UI doesn't edit: a port keeps its
// bind IP ("127.0.0.1:8080:3000" — dropping it would flip a localhost-only publish
// to all interfaces) and protocol; a volume keeps its mount options (":ro", ":z",
// ":cached", ":ro,z") and Windows-style source paths. Blank required-field rows
// serialize to "" and are dropped.

type PortRow = { ip: string; host: string; container: string; proto: string };
type VolumeRow = { source: string; target: string; ro: boolean; extra: string };

const parsePort = (raw: string): PortRow => {
  const [mapping, proto = ""] = raw.split("/");
  const parts = mapping.split(":");
  const container = parts[parts.length - 1] ?? "";
  const host = parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
  // Everything before host:container is the bind IP (e.g. "127.0.0.1").
  const ip = parts.length >= 3 ? parts.slice(0, parts.length - 2).join(":") : "";
  return { ip, host, container, proto };
};

const serializePort = (row: PortRow): string => {
  const container = row.container.trim();
  if (!container) return "";
  const host = row.host.trim();
  // A bind IP is only valid with a host port (compose "ip:host:container").
  let base = container;
  if (host) base = row.ip ? `${row.ip}:${host}:${container}` : `${host}:${container}`;
  return row.proto ? `${base}/${row.proto}` : base;
};

// Known short-syntax volume mount options — used to tell a trailing ":opts" group
// apart from a path segment so options aren't dropped and Windows drives (C:\…)
// aren't mis-split.
const VOLUME_OPTS = new Set([
  "ro", "rw", "z", "Z", "cached", "delegated", "consistent",
  "nocopy", "shared", "slave", "private", "rshared", "rslave", "rprivate",
]);

const parseVolume = (raw: string): VolumeRow => {
  const segs = raw.split(":");
  let opts = "";
  if (segs.length >= 2 && segs[segs.length - 1].split(",").every((t) => VOLUME_OPTS.has(t))) {
    opts = segs.pop() as string;
  }
  let source = "";
  let target = "";
  if (segs.length >= 2) {
    target = segs.pop() as string;
    source = segs.join(":"); // rejoin preserves a Windows drive (e.g. "C:\\data")
  } else {
    target = segs[0] ?? "";
  }
  const tokens = opts ? opts.split(",") : [];
  const ro = tokens.includes("ro");
  const extra = tokens.filter((o) => o && o !== "ro").join(",");
  return { source, target, ro, extra };
};

const serializeVolume = (row: VolumeRow): string => {
  const target = row.target.trim();
  if (!target) return "";
  const source = row.source.trim();
  const opts = [...(row.ro ? ["ro"] : []), ...(row.extra ? row.extra.split(",").filter(Boolean) : [])];
  const base = source ? `${source}:${target}` : target;
  return opts.length ? `${base}:${opts.join(",")}` : base;
};

const sameStrings = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const RESTART_OPTIONS = ["", "no", "always", "unless-stopped", "on-failure"] as const;

// Stateful images whose data would be lost across a cloud rebuild without backups.
const STATEFUL_IMAGE_RE =
  /(^|\/)(postgres|postgresql|mysql|mariadb|mongo|mongodb|redis|valkey|clickhouse|cassandra|couchdb|influxdb|elasticsearch|rabbitmq)(:|$)/i;
const isStatefulImage = (image?: string) => !!image && STATEFUL_IMAGE_RE.test(image);


const SkeletonBlock: React.FC<{ className: string }> = ({ className }) => (
  <div className={`animate-pulse rounded-md bg-muted ${className}`} />
);

// ─── Per-service domain section (always visible when expandable) ─────────────

const ServiceDomainSection: React.FC<{
  service: ComposeServiceInfo;
  projectName: string;
  onChange: (updates: Partial<ComposeServiceInfo>) => void;
}> = ({ service, projectName, onChange }) => {
  const { t } = useI18n();
  const d = t.importProject.composeServices.domain;
  const hasPorts = service.ports.length > 0;

  if (!hasPorts) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-muted/50">
          <Lock className="size-4 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{d.internalService}</p>
          <p className="text-xs text-muted-foreground">{d.noPublicPorts}</p>
        </div>
      </div>
    );
  }

  const primaryPort = service.exposedPort || serviceExposedPort(service) || "";
  const defaultSubdomain =
    service.name === "web" || service.name === "app" || service.name === "frontend"
      ? normalizeSubdomain(projectName)
      : normalizeSubdomain(`${projectName}-${service.name}`);

  // Routes shown in the card: the service's explicit publicEndpoints, else a
  // single route synthesized from the scalar exposedPort/domain. One row per
  // public port — each with its own domain (Convex: 3210 API + 3211 HTTP actions).
  const endpoints = ensurePublicEndpoints(service.publicEndpoints, {
    port: primaryPort,
    domain: service.domain || defaultSubdomain,
    customDomain: service.customDomain || "",
    domainType: service.domainType || "free",
  });

  // Persist edited routes; mirror the primary (entry[0]) back to the scalar
  // columns so single-route readers (BuildSummary, deploy payload) stay in sync.
  const applyEndpoints = (next: PublicEndpoint[]) => {
    const primary = next[0];
    onChange({
      publicEndpoints: next,
      exposedPort: primary?.port || primaryPort,
      domain: primary?.domainType === "custom" ? undefined : primary?.domain,
      customDomain: primary?.domainType === "custom" ? primary?.customDomain : undefined,
      domainType: primary?.domainType ?? "free",
    });
  };

  return (
    <div className="space-y-3">
      {/* Toggle row */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={`flex size-9 items-center justify-center rounded-lg ${
            service.exposed ? "bg-success-bg" : "bg-muted/50"
          }`}>
            <Globe className={`size-4 ${
              service.exposed ? "text-success" : "text-muted-foreground"
            }`} />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">{d.publicDomain}</p>
            <p className="text-xs text-muted-foreground">
              {service.exposed ? d.internetEnabled : d.privateByDefault}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onChange({ exposed: !service.exposed })}
          className={`relative h-[22px] w-10 rounded-full transition-colors ${
            service.exposed ? "bg-success-solid" : "border border-border/60 bg-muted"
          }`}
        >
          <span
            className={`absolute left-[3px] top-[3px] h-4 w-4 rounded-full shadow-sm transition-all ${
              service.exposed
                ? "translate-x-[18px] bg-white"
                : "translate-x-0 bg-background dark:bg-muted-foreground/70"
            }`}
          />
        </button>
      </div>

      {/* Per-port routes — one domain each, add/remove. */}
      {service.exposed && (
        <div className="animate-in fade-in slide-in-from-top-1 duration-200">
          <PublicEndpointsCard
            projectName={projectName}
            endpoints={endpoints}
            hasServer
            runtimePort={primaryPort}
            allowPortEdit
            saveMode="change"
            hideHeader
            portInline
            onChange={(next) => applyEndpoints(next)}
          />
        </div>
      )}
    </div>
  );
};

const ServiceCardSkeleton: React.FC = () => (
  <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
    <div className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <SkeletonBlock className="h-6 w-28" />
        <SkeletonBlock className="h-5 w-14" />
        <SkeletonBlock className="h-5 w-16" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <SkeletonBlock className="h-4 w-44" />
        <SkeletonBlock className="h-4 w-12" />
      </div>
    </div>

    <div className="border-t border-border/30 px-4 pb-4 sm:px-5 sm:pb-5">
      <div className="grid gap-3 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.72fr)]">
        <div className="rounded-xl border border-border/40 bg-muted/20 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <SkeletonBlock className="h-9 w-9 rounded-lg" />
              <div className="space-y-2">
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-3 w-24" />
              </div>
            </div>
            <SkeletonBlock className="h-[22px] w-10 rounded-full" />
          </div>
        </div>

        <div className="rounded-xl border border-border/40 bg-muted/20 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <SkeletonBlock className="h-4 w-36" />
              <SkeletonBlock className="h-3 w-28" />
            </div>
            <SkeletonBlock className="h-3 w-12" />
          </div>
        </div>
      </div>
    </div>
  </div>
);

const SharedEnvironmentCard: React.FC<{
  envVars: EnvVarRow[];
  rootEnvVars: EnvVarRow[];
  onChange: (envVars: EnvVarRow[]) => void;
}> = ({ envVars, rootEnvVars, onChange }) => {
  const { t } = useI18n();
  const sh = t.importProject.composeServices.shared;
  const [envModalOpen, setEnvModalOpen] = useState(false);
  const envCount = envVars.filter((env) => env.key.trim()).length;
  const importedKeys = new Set(envVars.map((env) => env.key).filter(Boolean));
  const importableRootVars = rootEnvVars.filter((env) => env.key && !importedKeys.has(env.key));

  const importRootEnv = useCallback(() => {
    if (importableRootVars.length === 0) return;
    onChange([...envVars, ...importableRootVars.map((env) => ({ ...env, visible: true }))]);
  }, [envVars, importableRootVars, onChange]);

  return (
    <div className="rounded-xl border border-border/40 bg-muted/20 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <KeyRound className="size-4 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-foreground">{sh.title}</p>
              {rootEnvVars.length > 0 && (
                <span className="rounded-md bg-success-bg px-2 py-0.5 text-[11px] font-medium text-success">
                  {sh.rootEnvFound}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {envCount === 0
                ? sh.optionalVars
                : interpolate(envCount === 1 ? sh.sharedVariableOne : sh.sharedVariableOther, { count: String(envCount) })}
              {" "}{sh.overrideNote}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {importableRootVars.length > 0 && (
            <button
              type="button"
              onClick={importRootEnv}
              className="rounded-lg bg-muted/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {sh.importEnv}
            </button>
          )}
          <button
            type="button"
            onClick={() => setEnvModalOpen(true)}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {sh.manage}
          </button>
        </div>
      </div>

      <Modal
        isOpen={envModalOpen}
        onClose={() => setEnvModalOpen(false)}
        maxWidth="760px"
        maxHeight="86vh"
        overflow="hidden"
        showCloseButton={false}
      >
        <div className="border-b border-border/50 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <KeyRound className="size-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">
                  {sh.title}
                </p>
                <p className="text-xs text-muted-foreground">
                  {sh.modalSubtitle}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEnvModalOpen(false)}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              aria-label={sh.close}
            >
              <X className="size-4" />
            </button>
          </div>
          {importableRootVars.length > 0 && (
            <button
              type="button"
              onClick={importRootEnv}
              className="mt-3 rounded-lg bg-success-bg px-3 py-1.5 text-xs font-medium text-success transition-colors hover:bg-success-solid/15"
            >
              {interpolate(importableRootVars.length === 1 ? sh.importFromRootOne : sh.importFromRootOther, { count: String(importableRootVars.length) })}
            </button>
          )}
        </div>

        <div className="max-h-[calc(86vh-92px)] overflow-y-auto">
          <EnvironmentVariables
            mode="settings"
            showEditControls={true}
            isEditingMode={true}
            showSettingsActions={false}
            borderless
            envVars={envVars}
            onEnvVarsChange={onChange}
          />
        </div>
      </Modal>
    </div>
  );
};

// ─── Per-service configuration (ports / volumes / command / restart) ─────────

const ServiceConfigSection: React.FC<{
  service: ComposeServiceInfo;
  onChange: (updates: Partial<ComposeServiceInfo>) => void;
}> = ({ service, onChange }) => {
  const { config } = useDeployment();
  const { t } = useI18n();
  const cfg = t.importProject.composeServices.config;
  const cnt = t.importProject.counts;
  const isCloud = config.deployTarget === "cloud";
  const [open, setOpen] = useState(false);

  const [portRows, setPortRows] = useState<PortRow[]>(() => service.ports.map(parsePort));
  const [volumeRows, setVolumeRows] = useState<VolumeRow[]>(() => service.volumes.map(parseVolume));

  // Resync from external changes (API load / mode switch) without clobbering
  // in-progress local edits — mirrors the envRows bridge in ServiceCard.
  useEffect(() => {
    setPortRows((cur) =>
      sameStrings(cur.map(serializePort).filter(Boolean), service.ports)
        ? cur
        : service.ports.map(parsePort),
    );
  }, [service.ports]);
  useEffect(() => {
    setVolumeRows((cur) =>
      sameStrings(cur.map(serializeVolume).filter(Boolean), service.volumes)
        ? cur
        : service.volumes.map(parseVolume),
    );
  }, [service.volumes]);

  const commitPorts = useCallback(
    (rows: PortRow[]) => {
      setPortRows(rows);
      onChange({ ports: rows.map(serializePort).filter(Boolean) });
    },
    [onChange],
  );
  const commitVolumes = useCallback(
    (rows: VolumeRow[]) => {
      setVolumeRows(rows);
      onChange({ volumes: rows.map(serializeVolume).filter(Boolean) });
    },
    [onChange],
  );

  const routedPort = service.exposedPort || serviceExposedPort(service) || "";
  const statefulOnCloud = isCloud && (isStatefulImage(service.image) || service.volumes.length > 0);
  const portsStr = interpolate(service.ports.length === 1 ? cnt.portOne : cnt.portOther, { count: String(service.ports.length) });
  const volumesStr = interpolate(service.volumes.length === 1 ? cnt.volumeOne : cnt.volumeOther, { count: String(service.volumes.length) });
  const summary = interpolate(cfg.summary, { ports: portsStr, volumes: volumesStr });

  const inputCls =
    "w-full rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20";
  const labelCls = "text-xs font-semibold uppercase tracking-wider text-foreground/80";

  return (
    <div className="mt-3 rounded-xl border border-border/40 bg-muted/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-start"
      >
        <span className="flex items-center gap-2.5">
          <Settings2 className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{cfg.title}</span>
          <span className="text-xs text-muted-foreground">{summary}</span>
        </span>
        {open ? (
          <ChevronUp className="size-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-5 border-t border-border/30 px-4 py-4 animate-in fade-in slide-in-from-top-1 duration-200">
          {/* Ports */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Network className="size-4 text-foreground/70" />
              <span className={labelCls}>{cfg.ports}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{cfg.containerLabel}</span> {cfg.equalsInsideService}{" "}
              <span className="font-medium text-foreground">{cfg.publishedLabel}</span> {cfg.equalsReachableHost}
              {isCloud && ` ${cfg.cloudPortIgnored}`}
            </p>
            <div className="space-y-2">
              {portRows.map((row, i) => {
                const isRouted = !!row.container && row.container === routedPort;
                return (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={row.host}
                      onChange={(e) =>
                        commitPorts(portRows.map((r, j) => (j === i ? { ...r, host: e.target.value } : r)))
                      }
                      placeholder={isCloud ? cfg.naOnCloud : cfg.publishedLabel}
                      disabled={isCloud}
                      inputMode="numeric"
                      className={cn(inputCls, "flex-1", isCloud && "opacity-50")}
                    />
                    <span className="text-muted-foreground">:</span>
                    <input
                      value={row.container}
                      onChange={(e) =>
                        commitPorts(portRows.map((r, j) => (j === i ? { ...r, container: e.target.value } : r)))
                      }
                      placeholder={cfg.containerLabel}
                      inputMode="numeric"
                      className={cn(inputCls, "flex-1")}
                    />
                    {isRouted && (
                      <span className="shrink-0 rounded-md bg-success-bg px-2 py-0.5 text-[11px] font-medium text-success">
                        {cfg.publicBadge}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => commitPorts(portRows.filter((_, j) => j !== i))}
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      aria-label={cfg.removePort}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => commitPorts([...portRows, { ip: "", host: "", container: "", proto: "" }])}
                className="inline-flex items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Plus className="size-3.5" /> {cfg.addPort}
              </button>
            </div>
          </div>

          {/* Volumes */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <HardDrive className="size-4 text-foreground/70" />
              <span className={labelCls}>{cfg.volumes}</span>
            </div>
            {statefulOnCloud && (
              <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {cfg.statefulWarnPart1}<span className="font-medium">{cfg.statefulWarnBold}</span>{cfg.statefulWarnPart2}
                </span>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {cfg.volumeHint}
              {isCloud && ` ${cfg.volumeCloudNote}`}
            </p>
            <div className="space-y-2">
              {volumeRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={row.source}
                    onChange={(e) =>
                      commitVolumes(volumeRows.map((r, j) => (j === i ? { ...r, source: e.target.value } : r)))
                    }
                    placeholder={cfg.sourcePlaceholder}
                    disabled={isCloud}
                    className={cn(inputCls, "flex-1", isCloud && "opacity-50")}
                  />
                  <span className="text-muted-foreground">:</span>
                  <input
                    value={row.target}
                    onChange={(e) =>
                      commitVolumes(volumeRows.map((r, j) => (j === i ? { ...r, target: e.target.value } : r)))
                    }
                    placeholder={cfg.containerPathPlaceholder}
                    disabled={isCloud}
                    className={cn(inputCls, "flex-1", isCloud && "opacity-50")}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      commitVolumes(volumeRows.map((r, j) => (j === i ? { ...r, ro: !r.ro } : r)))
                    }
                    disabled={isCloud}
                    className={cn(
                      "shrink-0 rounded-md px-2 py-1 text-[11px] font-medium",
                      row.ro ? "bg-primary/10 text-primary" : "bg-muted/60 text-muted-foreground",
                      isCloud && "opacity-50",
                    )}
                    title={cfg.readOnlyMount}
                  >
                    ro
                  </button>
                  <button
                    type="button"
                    onClick={() => commitVolumes(volumeRows.filter((_, j) => j !== i))}
                    className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    aria-label={cfg.removeVolume}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={isCloud}
                onClick={() => commitVolumes([...volumeRows, { source: "", target: "", ro: false, extra: "" }])}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                  isCloud && "cursor-not-allowed opacity-50 hover:bg-muted/60 hover:text-muted-foreground",
                )}
              >
                <Plus className="size-3.5" /> {cfg.addVolume}
              </button>
            </div>
          </div>

          {/* Command + Restart */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <span className={labelCls}>{cfg.command}</span>
              <input
                value={service.command ?? ""}
                onChange={(e) => onChange({ command: e.target.value || undefined })}
                placeholder={cfg.imageDefault}
                className={cn(inputCls, "font-mono")}
              />
            </div>
            <div className="space-y-1.5">
              <span className={labelCls}>{cfg.restartPolicy}</span>
              <select
                value={service.restart ?? ""}
                onChange={(e) => onChange({ restart: e.target.value || undefined })}
                className={inputCls}
              >
                {RESTART_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt === "" ? cfg.restartDefault : opt}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Service card ────────────────────────────────────────────────────────────

const ServiceCard: React.FC<{
  service: ComposeServiceInfo;
  projectName: string;
  onUpdate: (updates: Partial<ComposeServiceInfo>) => void;
  onEnvChange: (env: Record<string, string>) => void;
  onDelete: () => void;
}> = ({ service, projectName, onUpdate, onEnvChange, onDelete }) => {
  const { t } = useI18n();
  const { config } = useDeployment();
  const cs = t.importProject.composeServices;
  const cnt = t.importProject.counts;
  const missingCount = missingEnvCount(service);
  const envCount = Object.keys(service.environment).length;
  const [envModalOpen, setEnvModalOpen] = useState(false);
  // #336: in the folder-upload flow the scan masks env — reveal THIS service's
  // real values from the upload session (write-gated on the API). Only wired
  // when an upload session exists; git/edit flows have no session-scoped source.
  const uploadSessionId = config.uploadSessionId;
  const onRevealAll = uploadSessionId
    ? async () => (await folderApi.reveal(uploadSessionId)).environments[service.name] ?? {}
    : undefined;
  const [envRows, setEnvRows] = useState<EnvVarRow[]>(() =>
    envToArray(service.environment, {}, service.environmentMeta),
  );

  const statusLabel = service.exposed
    ? cs.status.public
    : service.ports.length > 0
      ? cs.status.private
      : cs.status.internal;
  const ports = service.ports.map(portDisplay);

  /** Bridge: EnvironmentVariables uses editable rows - our service config persists Record<string,string>. */
  useEffect(() => {
    setEnvRows((current) => {
      if (envRecordsEqual(arrayToEnv(current), service.environment)) return current;
      return envToArray(service.environment, visibilityByKey(current), service.environmentMeta);
    });
  }, [service.environment, service.environmentMeta]);

  const handleEnvChange = useCallback(
    (vars: EnvVarRow[]) => {
      setEnvRows(vars);
      onEnvChange(arrayToEnv(vars));
    },
    [onEnvChange],
  );

  // Environment-variables card — sits in the right column beside the domain card.
  const envButton = (extra = "") => (
    <button
      type="button"
      onClick={() => setEnvModalOpen(true)}
      className={cn(
        "w-full self-start rounded-xl border border-border/40 bg-muted/20 px-4 py-3 text-start transition-colors hover:bg-muted/30",
        extra,
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{cs.card.envVars}</p>
          <p className="truncate text-xs text-muted-foreground">
            {envCount === 0
              ? cs.card.noneConfigured
              : interpolate(envCount === 1 ? cs.card.variablesConfiguredOne : cs.card.variablesConfiguredOther, { count: String(envCount) })}
            {missingCount > 0 && (
              <span className="font-medium text-warning">
                {" "}{interpolate(cs.card.missingSuffix, { count: String(missingCount) })}
              </span>
            )}
          </p>
        </div>
        <span className="shrink-0 text-xs font-medium text-primary">{cs.card.manage}</span>
      </div>
    </button>
  );

  return (
    <div
      className={`border rounded-2xl bg-card overflow-hidden transition-colors ${
        service.exposed
          ? "border-success-border ring-1 ring-success-border"
          : "border-border/50"
      }`}
    >
      {/* Header row */}
      <div className="flex w-full items-start gap-3 p-4 sm:p-5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="text-base font-semibold leading-6 text-foreground">{service.name}</p>
            {ports.map((port, index) => (
              <span
                key={`${port}-${index}`}
                className="rounded-md bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground"
              >
                :{port}
              </span>
            ))}
            <span
              className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                service.exposed
                  ? "bg-success-bg text-success"
                  : "bg-muted/60 text-muted-foreground"
              }`}
            >
              {statusLabel}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="max-w-full truncate">
              {service.image || interpolate(cs.card.buildLabel, { value: service.build || "." })}
            </span>
            {service.dependsOn.length > 0 && (
              <span>{interpolate(service.dependsOn.length === 1 ? cnt.depOne : cnt.depOther, { count: String(service.dependsOn.length) })}</span>
            )}
            {service.volumes.length > 0 && (
              <span>{interpolate(service.volumes.length === 1 ? cnt.volumeOne : cnt.volumeOther, { count: String(service.volumes.length) })}</span>
            )}
          </div>
        </div>
        <DropdownMenu
          align="right"
          trigger={<MoreHorizontal className="size-4 text-muted-foreground" />}
          triggerClassName="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          actions={[
            {
              id: "edit",
              label: cs.card.edit,
              icon: <Pencil className="size-4" />,
              onClick: () => setEnvModalOpen(true),
            },
            {
              id: "delete",
              label: cs.card.delete,
              icon: <Trash2 className="size-4" />,
              variant: "danger",
              onClick: onDelete,
            },
          ]}
        />
      </div>

      <div className="border-t border-border/30 px-4 pb-4 sm:px-5 sm:pb-5">
        <div className="grid gap-3 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.72fr)]">
          <div
            className={`rounded-xl border px-4 py-3 transition-colors ${
              service.exposed
                ? "border-success-border bg-success-bg"
                : "border-border/40 bg-muted/20"
            }`}
          >
            <ServiceDomainSection
              service={service}
              projectName={projectName}
              onChange={onUpdate}
            />
          </div>
          {envButton()}
        </div>

        <ServiceConfigSection service={service} onChange={onUpdate} />
      </div>

      <Modal
        isOpen={envModalOpen}
        onClose={() => setEnvModalOpen(false)}
        maxWidth="760px"
        maxHeight="86vh"
        overflow="hidden"
        showCloseButton={false}
      >
        <div className="border-b border-border/50 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <KeyRound className="size-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">
                  {service.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {cs.card.envVars}
                  {envCount > 0 && ` ${interpolate(envCount === 1 ? cs.card.variableSuffixOne : cs.card.variableSuffixOther, { count: String(envCount) })}`}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEnvModalOpen(false)}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
              aria-label={cs.card.closeEnv}
            >
              <X className="size-4" />
            </button>
          </div>
          {missingCount > 0 && (
            <div className="mt-3 inline-flex rounded-md bg-warning-bg px-2.5 py-1 text-xs font-medium text-warning">
              {interpolate(missingCount === 1 ? cs.card.needsValueOne : cs.card.needsValueOther, { count: String(missingCount) })}
            </div>
          )}
        </div>

        <div className="max-h-[calc(86vh-92px)] overflow-y-auto">
          <EnvironmentVariables
            mode="settings"
            showEditControls={true}
            isEditingMode={true}
            showSettingsActions={false}
            borderless
            envVars={envRows}
            envMeta={service.environmentMeta}
            onEnvVarsChange={handleEnvChange}
            onRevealAll={onRevealAll}
          />
        </div>
      </Modal>
    </div>
  );
};

// ─── Main component ──────────────────────────────────────────────────────────

const ComposeServices: React.FC = () => {
  const { config, updateConfig } = useDeployment();
  const { baseDomain } = usePlatform();
  const { t } = useI18n();
  const cs = t.importProject.composeServices;
  const cnt = t.importProject.counts;

  const services = config.services || [];
  const sharedEnvVars = config.envVars || [];
  const rootEnvVars = config.rootEnvVars || [];
  const isServiceDeployment = usesServiceDeployment(config);
  const [modeOptionsOpen, setModeOptionsOpen] = useState(false);

  const updateService = useCallback(
    (index: number, updates: Partial<ComposeServiceInfo>) => {
      const next = services.map((s, i) => (i === index ? { ...s, ...updates } : s));
      updateConfig({ services: next });
    },
    [services, updateConfig],
  );

  const updateServiceEnv = useCallback(
    (index: number, env: Record<string, string>) => {
      const next = services.map((s, i) => (i === index ? { ...s, environment: env } : s));
      updateConfig({ services: next });
    },
    [services, updateConfig],
  );

  const deleteService = useCallback(
    (index: number) => {
      updateConfig({ services: services.filter((_, i) => i !== index) });
    },
    [services, updateConfig],
  );

  const updateSharedEnv = useCallback(
    (envVars: EnvVarRow[]) => {
      updateConfig({ envVars });
    },
    [updateConfig],
  );

  const buildCount = services.filter((s) => s.build).length;
  const exposedCount = services.filter((s) => s.exposed).length;

  // Detect two routes resolving to the SAME hostname (across every service ×
  // port). The deploy also skips duplicates, but flag it here so the operator
  // can change the domain before shipping a route that silently won't bind.
  const projectNameForHost = config.projectName || config.repo || "";
  const duplicateHosts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const svc of services) {
      if (!svc.exposed) continue;
      const defaultSub =
        svc.name === "web" || svc.name === "app" || svc.name === "frontend"
          ? normalizeSubdomain(projectNameForHost)
          : normalizeSubdomain(`${projectNameForHost}-${svc.name}`);
      const eps = ensurePublicEndpoints(svc.publicEndpoints, {
        port: svc.exposedPort || serviceExposedPort(svc) || "",
        domain: svc.domain || defaultSub,
        customDomain: svc.customDomain || "",
        domainType: svc.domainType || "free",
      });
      for (const ep of eps) {
        const host =
          ep.domainType === "custom"
            ? ep.customDomain?.trim().toLowerCase()
            : ep.domain
              ? `${ep.domain}.${baseDomain}`.toLowerCase()
              : undefined;
        if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
      }
    }
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([host]) => host));
  }, [services, baseDomain, projectNameForHost]);

  const setDeploymentMode = useCallback(
    (mode: "services" | "single") => {
      updateConfig(getModeSwitchUpdates(config, mode));
    },
    [config, updateConfig],
  );

  const modeOptions = [
    {
      id: "services" as const,
      label: cs.main.modeServicesLabel,
      description: cs.main.modeServicesDesc,
      icon: Layers,
    },
    {
      id: "single" as const,
      label: cs.main.modeSingleLabel,
      description: cs.main.modeSingleDesc,
      icon: Code2,
    },
  ];

  const selectedMode = modeOptions.find((option) => option.id === config.serviceDeploymentMode) ?? modeOptions[0];

  return (
    <div className="space-y-5">
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="px-5 py-5 space-y-6">
          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-orange-500/10 rounded-xl">
              <Boxes className="w-6 h-6 text-orange-500" />
            </div>
            <div>
              <h3 className="text-[15px] font-semibold text-foreground">Docker Compose</h3>
              <p className="text-xs text-muted-foreground">
                {isServiceDeployment ? cs.main.deployingServices : cs.main.deployingSingle}
                {isServiceDeployment && (
                  <>
                    {" · "}
                    {interpolate(services.length === 1 ? cnt.serviceOne : cnt.serviceOther, { count: String(services.length) })}
                    {buildCount > 0 && ` ${interpolate(cs.main.buildCountSuffix, { count: String(buildCount) })}`}
                    {exposedCount > 0 && ` ${interpolate(cs.main.exposedCountSuffix, { count: String(exposedCount) })}`}
                  </>
                )}
              </p>
            </div>
          </div>

          {isServiceDeployment ? (
            <>
              <SharedEnvironmentCard
                envVars={sharedEnvVars}
                rootEnvVars={rootEnvVars}
                onChange={updateSharedEnv}
              />

              {/* Duplicate-domain warning — two routes can't share a hostname. */}
              {duplicateHosts.size > 0 && (
                <div className="flex items-start gap-3 rounded-xl border border-warning-border bg-warning-bg px-4 py-3">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium text-warning">
                      {cs.domain.duplicateTitle}
                    </p>
                    <p className="mt-0.5 text-warning/80">
                      {cs.domain.duplicateDescription}{" "}
                      <span className="font-mono">{[...duplicateHosts].join(", ")}</span>
                    </p>
                  </div>
                </div>
              )}

              {/* Services list */}
              {services.length > 0 ? (
                <div className="space-y-4">
                  {services.map((svc, i) => (
                    <ServiceCard
                      key={svc.name}
                      service={svc}
                      projectName={config.projectName || config.repo}
                      onUpdate={(updates) => updateService(i, updates)}
                      onEnvChange={(env) => updateServiceEnv(i, env)}
                      onDelete={() => deleteService(i)}
                    />
                  ))}
                </div>
              ) : (
                <div className="space-y-4">
                  <ServiceCardSkeleton />
                  <ServiceCardSkeleton />
                </div>
              )}

              {/* Info */}
              <div className="p-4 bg-muted/30 rounded-xl border border-border/50">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {cs.main.infoPart1}
                  <strong className="text-foreground">{cs.main.infoBold}</strong>{cs.main.infoPart2}
                </p>
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
              <p className="text-sm text-muted-foreground leading-relaxed">
                {cs.main.singleAppNote}
              </p>
            </div>
          )}

          <div className="border-t border-border/50 pt-4">
            <button
              type="button"
              onClick={() => setModeOptionsOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-4 text-start"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-xl bg-muted/40">
                  <Settings2 className="size-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">{cs.main.deploymentMode}</p>
                  <p className="text-xs text-muted-foreground">
                    {interpolate(cs.main.deploymentModeDesc, { mode: selectedMode.label })}
                  </p>
                </div>
              </div>
              {modeOptionsOpen ? (
                <ChevronUp className="size-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="size-4 text-muted-foreground" />
              )}
            </button>

            {modeOptionsOpen && (
              <div className="mt-4 rounded-xl border border-border/50 bg-muted/20 p-4">
                <div className="grid gap-2 sm:grid-cols-2">
                  {modeOptions.map((option) => {
                    const Icon = option.icon;
                    const selected = config.serviceDeploymentMode === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setDeploymentMode(option.id)}
                        className={cn(
                          "flex items-start gap-3 rounded-xl border p-3 text-start transition-colors",
                          selected
                            ? "border-primary/40 bg-primary/10 text-foreground"
                            : "border-border/50 bg-background/50 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                        )}
                      >
                        <span className={cn(
                          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
                          selected ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                        )}>
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{option.label}</span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                            {option.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {!isServiceDeployment && <BuildSettings />}
    </div>
  );
};

export default React.memo(ComposeServices);
