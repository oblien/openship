"use client";

import React, { useState, useCallback, useEffect } from "react";
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
import { usePlatform } from "@/context/PlatformContext";
import {
  usesServiceDeployment,
  type ComposeServiceInfo,
} from "@/context/deployment/types";
import { getModeSwitchUpdates } from "@/context/deployment/mode-config";
import { normalizeSubdomain, normalizeSubdomainInput } from "@/utils/subdomain";
import { Modal } from "@/components/ui/Modal";
import DropdownMenu from "@/components/ui/DropdownMenu";
import EnvironmentVariables from "./EnvironmentVariables";
import BuildSettings from "./BuildSettings";
import { cn } from "@/lib/utils";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getExposedPort = (svc: ComposeServiceInfo) =>
  svc.ports[0]?.split(":").pop()?.split("/")[0];

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

const portDisplay = (port: string) => port.split(":").pop()?.split("/")[0] || port;

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
  const { baseDomain } = usePlatform();
  const hasPorts = service.ports.length > 0;

  if (!hasPorts) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-muted/50">
          <Lock className="size-4 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">Internal service</p>
          <p className="text-xs text-muted-foreground">No public ports detected</p>
        </div>
      </div>
    );
  }

  const exposedPort = service.exposedPort || getExposedPort(service) || "";
  const domainType = service.domainType || "free";
  const defaultSubdomain =
    service.name === "web" || service.name === "app" || service.name === "frontend"
      ? normalizeSubdomain(projectName)
      : normalizeSubdomain(`${projectName}-${service.name}`);

  return (
    <div className="space-y-4">
      {/* Toggle row */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={`flex size-9 items-center justify-center rounded-lg ${
            service.exposed ? "bg-emerald-500/10" : "bg-muted/50"
          }`}>
            <Globe className={`size-4 ${
              service.exposed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
            }`} />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Public domain</p>
            <p className="text-xs text-muted-foreground">
              {service.exposed ? "Internet traffic enabled" : "Private by default"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onChange({ exposed: !service.exposed })}
          className={`relative h-[22px] w-10 rounded-full transition-colors ${
            service.exposed ? "bg-emerald-500" : "border border-border/60 bg-muted"
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

      {/* Domain config - prominent when on */}
      {service.exposed && (
        <div className="ml-12 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
          {/* Port picker (if multiple) */}
          {service.ports.length > 1 && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Exposed Port
              </label>
              <select
                value={exposedPort}
                onChange={(e) => onChange({ exposedPort: e.target.value })}
                className="w-full px-3.5 py-2.5 bg-background border border-border/50 rounded-xl text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                {service.ports.map((p) => {
                  const port = portDisplay(p);
                  return (
                    <option key={p} value={port}>
                      Port {port}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {/* Domain type toggle + input */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-muted-foreground">Domain</label>
              <div className="flex items-center bg-muted/60 rounded-lg p-0.5">
                <button
                  type="button"
                  onClick={() => onChange({ domainType: "free" })}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                    domainType === "free"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Free
                </button>
                <button
                  type="button"
                  onClick={() => onChange({ domainType: "custom" })}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                    domainType === "custom"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Custom
                </button>
              </div>
            </div>
            {domainType === "free" ? (
              <div className="relative">
                <input
                  type="text"
                  value={service.domain ?? defaultSubdomain}
                  onChange={(e) =>
                    onChange({
                      domain: normalizeSubdomainInput(e.target.value),
                    })
                  }
                  placeholder={defaultSubdomain}
                  className="w-full px-3.5 py-2.5 pr-16 bg-background border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  .{baseDomain}
                </span>
              </div>
            ) : (
              <input
                type="text"
                value={service.customDomain || ""}
                onChange={(e) => onChange({ customDomain: e.target.value.toLowerCase() })}
                placeholder="api.example.com"
                className="w-full px-3.5 py-2.5 bg-background border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            )}
          </div>

          {service.ports.length === 1 && (
            <p className="text-xs text-muted-foreground">
              Routing traffic to port{" "}
              <span className="font-mono font-medium text-foreground">{exposedPort}</span>
            </p>
          )}
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
              <p className="text-sm font-medium text-foreground">Shared environment</p>
              {rootEnvVars.length > 0 && (
                <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  Root .env found
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {envCount === 0
                ? "Optional vars applied to every service"
                : `${envCount} shared variable${envCount === 1 ? "" : "s"}`}
              {" "}· service values override shared values
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
              Import .env
            </button>
          )}
          <button
            type="button"
            onClick={() => setEnvModalOpen(true)}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Manage
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
                  Shared environment
                </p>
                <p className="text-xs text-muted-foreground">
                  Applied to every service. Service variables win on conflict.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEnvModalOpen(false)}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              aria-label="Close shared environment"
            >
              <X className="size-4" />
            </button>
          </div>
          {importableRootVars.length > 0 && (
            <button
              type="button"
              onClick={importRootEnv}
              className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400"
            >
              Import {importableRootVars.length} variable{importableRootVars.length === 1 ? "" : "s"} from root .env
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

  const routedPort = service.exposedPort || getExposedPort(service) || "";
  const statefulOnCloud = isCloud && (isStatefulImage(service.image) || service.volumes.length > 0);
  const summary = `${service.ports.length} port${service.ports.length === 1 ? "" : "s"} · ${service.volumes.length} volume${service.volumes.length === 1 ? "" : "s"}`;

  const inputCls =
    "w-full rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20";
  const labelCls = "text-xs font-semibold uppercase tracking-wider text-foreground/80";

  return (
    <div className="mt-3 rounded-xl border border-border/40 bg-muted/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2.5">
          <Settings2 className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Configuration</span>
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
              <span className={labelCls}>Ports</span>
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Container</span> = inside the service ·{" "}
              <span className="font-medium text-foreground">Published</span> = reachable on the host.
              {isCloud && " On cloud the published port is ignored — only the container port is routed."}
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
                      placeholder={isCloud ? "n/a on cloud" : "Published"}
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
                      placeholder="Container"
                      inputMode="numeric"
                      className={cn(inputCls, "flex-1")}
                    />
                    {isRouted && (
                      <span className="shrink-0 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                        public
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => commitPorts(portRows.filter((_, j) => j !== i))}
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      aria-label="Remove port"
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
                <Plus className="size-3.5" /> Add port
              </button>
            </div>
          </div>

          {/* Volumes */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <HardDrive className="size-4 text-foreground/70" />
              <span className={labelCls}>Volumes</span>
            </div>
            {statefulOnCloud && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Stateful service on cloud: data lives on the workspace's persistent disk
                  (survives restarts) but is <span className="font-medium">not carried across
                  rebuilds</span> unless backups are enabled. Docker volume mounts don't apply.
                </span>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Named volume or host path → container path.
              {isCloud &&
                " On cloud these mounts don't apply — data persists on the workspace's disk (not across rebuilds without backups)."}
            </p>
            <div className="space-y-2">
              {volumeRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={row.source}
                    onChange={(e) =>
                      commitVolumes(volumeRows.map((r, j) => (j === i ? { ...r, source: e.target.value } : r)))
                    }
                    placeholder="Source"
                    disabled={isCloud}
                    className={cn(inputCls, "flex-1", isCloud && "opacity-50")}
                  />
                  <span className="text-muted-foreground">:</span>
                  <input
                    value={row.target}
                    onChange={(e) =>
                      commitVolumes(volumeRows.map((r, j) => (j === i ? { ...r, target: e.target.value } : r)))
                    }
                    placeholder="Container path"
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
                    title="Read-only mount"
                  >
                    ro
                  </button>
                  <button
                    type="button"
                    onClick={() => commitVolumes(volumeRows.filter((_, j) => j !== i))}
                    className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    aria-label="Remove volume"
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
                <Plus className="size-3.5" /> Add volume
              </button>
            </div>
          </div>

          {/* Command + Restart */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <span className={labelCls}>Command</span>
              <input
                value={service.command ?? ""}
                onChange={(e) => onChange({ command: e.target.value || undefined })}
                placeholder="(image default)"
                className={cn(inputCls, "font-mono")}
              />
            </div>
            <div className="space-y-1.5">
              <span className={labelCls}>Restart policy</span>
              <select
                value={service.restart ?? ""}
                onChange={(e) => onChange({ restart: e.target.value || undefined })}
                className={inputCls}
              >
                {RESTART_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt === "" ? "Default (unless-stopped)" : opt}
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
  const missingCount = missingEnvCount(service);
  const envCount = Object.keys(service.environment).length;
  const [envModalOpen, setEnvModalOpen] = useState(false);
  const [envRows, setEnvRows] = useState<EnvVarRow[]>(() =>
    envToArray(service.environment, {}, service.environmentMeta),
  );

  const statusLabel = service.exposed
    ? "Public"
    : service.ports.length > 0
      ? "Private"
      : "Internal";
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

  return (
    <div
      className={`border rounded-2xl bg-card overflow-hidden transition-colors ${
        service.exposed
          ? "border-emerald-500/25 ring-1 ring-emerald-500/10 dark:border-emerald-400/20 dark:ring-emerald-400/10"
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
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted/60 text-muted-foreground"
              }`}
            >
              {statusLabel}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="max-w-full truncate">
              {service.image || `Build: ${service.build || "."}`}
            </span>
            {service.dependsOn.length > 0 && (
              <span>{service.dependsOn.length} dep{service.dependsOn.length === 1 ? "" : "s"}</span>
            )}
            {service.volumes.length > 0 && (
              <span>{service.volumes.length} volume{service.volumes.length === 1 ? "" : "s"}</span>
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
              label: "Edit",
              icon: <Pencil className="size-4" />,
              onClick: () => setEnvModalOpen(true),
            },
            {
              id: "delete",
              label: "Delete",
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
                ? "border-emerald-500/20 bg-emerald-500/5 dark:border-emerald-400/15 dark:bg-emerald-400/10"
                : "border-border/40 bg-muted/20"
            }`}
          >
            <ServiceDomainSection
              service={service}
              projectName={projectName}
              onChange={onUpdate}
            />
          </div>
          <button
            type="button"
            onClick={() => setEnvModalOpen(true)}
            className="w-full self-start rounded-xl border border-border/40 bg-muted/20 px-4 py-3 text-left transition-colors hover:bg-muted/30"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">Environment variables</p>
                <p className="truncate text-xs text-muted-foreground">
                  {envCount === 0
                    ? "None configured"
                    : `${envCount} variable${envCount === 1 ? "" : "s"} configured`}
                  {missingCount > 0 && (
                    <span className="font-medium text-amber-600 dark:text-amber-400">
                      {" "}· {missingCount} missing
                    </span>
                  )}
                </p>
              </div>
              <span className="shrink-0 text-xs font-medium text-primary">Manage</span>
            </div>
          </button>
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
                  Environment variables
                  {envCount > 0 && ` · ${envCount} variable${envCount === 1 ? "" : "s"}`}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEnvModalOpen(false)}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
              aria-label="Close environment variables"
            >
              <X className="size-4" />
            </button>
          </div>
          {missingCount > 0 && (
            <div className="mt-3 inline-flex rounded-md bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
              {missingCount} environment variable{missingCount === 1 ? "" : "s"} need{missingCount === 1 ? "s" : ""} value
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
          />
        </div>
      </Modal>
    </div>
  );
};

// ─── Main component ──────────────────────────────────────────────────────────

const ComposeServices: React.FC = () => {
  const { config, updateConfig } = useDeployment();

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

  const setDeploymentMode = useCallback(
    (mode: "services" | "single") => {
      updateConfig(getModeSwitchUpdates(config, mode));
    },
    [config, updateConfig],
  );

  const modeOptions = [
    {
      id: "services" as const,
      label: "Service stack",
      description: "Deploy every compose service with its own runtime and domain.",
      icon: Layers,
    },
    {
      id: "single" as const,
      label: "Single app",
      description: "Use the normal build and start command flow for one app.",
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
                {isServiceDeployment ? "Deploying as services" : "Deploying as a single app"}
                {isServiceDeployment && (
                  <>
                    {" · "}
                    {services.length} service{services.length !== 1 ? "s" : ""}
                    {buildCount > 0 && ` · ${buildCount} build`}
                    {exposedCount > 0 && ` · ${exposedCount} exposed`}
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
                  Internal services can reach each other by service name. Enable{" "}
                  <strong className="text-foreground">Public domain</strong> only for services that
                  should receive internet traffic.
                </p>
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Parsed compose services are kept for later, but this deployment will use the normal
                single-app build, start command, environment, and domain settings.
              </p>
            </div>
          )}

          <div className="border-t border-border/50 pt-4">
            <button
              type="button"
              onClick={() => setModeOptionsOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-4 text-left"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-xl bg-muted/40">
                  <Settings2 className="size-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Deployment mode</p>
                  <p className="text-xs text-muted-foreground">
                    {selectedMode.label} · Switch between service stack and single app handling.
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
                          "flex items-start gap-3 rounded-xl border p-3 text-left transition-colors",
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
