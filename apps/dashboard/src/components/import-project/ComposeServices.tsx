"use client";

import React, { useState, useCallback, useMemo } from "react";
import {
  Layers,
  Globe,
  Database,
  Server,
  ChevronDown,
  ChevronUp,
  Hash,
  Container,
  Lock,
  ArrowRight,
} from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import { usePlatform } from "@/context/PlatformContext";
import { STACK_ICONS } from "@repo/core";
import type { ComposeServiceInfo } from "@/context/deployment/types";
import EnvironmentVariables from "./EnvironmentVariables";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const isDbService = (svc: ComposeServiceInfo) =>
  /postgres|mysql|mariadb|mongo|redis|memcached|cassandra|clickhouse|influx|minio/i.test(
    svc.image || svc.name,
  );

const getExposedPort = (svc: ComposeServiceInfo) =>
  svc.ports[0]?.split(":").pop()?.split("/")[0];

/** Convert Record<string,string> ↔ Array<{key,value,visible}> */
const envToArray = (env: Record<string, string>) =>
  Object.entries(env).map(([key, value]) => ({ key, value, visible: false }));

const arrayToEnv = (arr: Array<{ key: string; value: string }>) => {
  const env: Record<string, string> = {};
  for (const { key, value } of arr) {
    if (key) env[key] = value;
  }
  return env;
};

// ─── Per-service domain section (always visible when expandable) ─────────────

const ServiceDomainSection: React.FC<{
  service: ComposeServiceInfo;
  projectName: string;
  onChange: (updates: Partial<ComposeServiceInfo>) => void;
}> = ({ service, projectName, onChange }) => {
  const { hostDomain } = usePlatform();
  const baseDomain = hostDomain || "opsh.io";
  const hasPorts = service.ports.length > 0;
  const isDb = isDbService(service);

  if (!hasPorts || isDb) {
    return (
      <div className="flex items-center gap-2.5 px-4 py-3 bg-muted/20 rounded-xl border border-border/30">
        <Lock className="size-4 text-muted-foreground/40" />
        <span className="text-sm text-muted-foreground">
          {isDb ? "Database — internal only, no public access" : "No ports — internal only"}
        </span>
      </div>
    );
  }

  const exposedPort = service.exposedPort || getExposedPort(service) || "";
  const domainType = service.domainType || "free";
  const defaultSubdomain =
    service.name === "web" || service.name === "app" || service.name === "frontend"
      ? projectName.toLowerCase()
      : `${projectName}-${service.name}`.toLowerCase();

  return (
    <div className="space-y-3">
      {/* Toggle row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Globe className={`size-4 ${
            service.exposed ? "text-primary" : "text-muted-foreground"
          }`} />
          <span className="text-sm font-medium text-foreground">Public Domain</span>
        </div>
        <button
          type="button"
          onClick={() => onChange({ exposed: !service.exposed })}
          className={`relative w-10 h-[22px] rounded-full transition-colors ${
            service.exposed ? "bg-primary" : "bg-input"
          }`}
        >
          <span
            className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full transition-all ${
              service.exposed
                ? "translate-x-[18px] bg-primary-foreground"
                : "translate-x-0 bg-background"
            }`}
          />
        </button>
      </div>

      {!service.exposed && (
        <p className="text-sm text-muted-foreground">
          Enable to expose this service on a public domain
        </p>
      )}

      {/* Domain config — prominent when on */}
      {service.exposed && (
        <div className="p-3.5 bg-primary/5 rounded-xl space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
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
                  const port = p.split(":").pop()?.split("/")[0] || p;
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
                      domain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
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

// ─── Service card ────────────────────────────────────────────────────────────

const ServiceCard: React.FC<{
  service: ComposeServiceInfo;
  projectName: string;
  onUpdate: (updates: Partial<ComposeServiceInfo>) => void;
  onEnvChange: (env: Record<string, string>) => void;
}> = ({ service, projectName, onUpdate, onEnvChange }) => {
  const [expanded, setExpanded] = useState(false);
  const { hostDomain } = usePlatform();
  const baseDomain = hostDomain || "opsh.io";

  const isDb = isDbService(service);
  const ServiceIcon = isDb ? Database : service.build ? Container : Server;
  const iconColor = isDb
    ? "text-amber-500 bg-amber-500/10"
    : service.build
      ? "text-primary bg-primary/10"
      : "text-muted-foreground bg-muted/60";

  const exposedPort = getExposedPort(service);
  const domainDisplay = service.exposed
    ? service.domainType === "custom" && service.customDomain
      ? service.customDomain
      : `${service.domain || service.name}.${baseDomain}`
    : null;

  /** Bridge: EnvironmentVariables uses {key,value,visible}[] — our service uses Record<string,string> */
  const envArray = useMemo(() => envToArray(service.environment), [service.environment]);
  const handleEnvChange = useCallback(
    (vars: Array<{ key: string; value: string; visible: boolean }>) => {
      onEnvChange(arrayToEnv(vars));
    },
    [onEnvChange],
  );

  return (
    <div
      className={`border rounded-xl bg-card overflow-hidden transition-colors ${
        service.exposed ? "border-primary/30" : "border-border/50"
      }`}
    >
      {/* Header row */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-4 hover:bg-muted/20 transition-colors"
      >
        <div className={`p-2 rounded-lg ${iconColor}`}>
          <ServiceIcon className="w-4 h-4" />
        </div>
        <div className="flex-1 text-left min-w-0">
          <p className="text-sm font-medium text-foreground">{service.name}</p>
          <p className="text-xs text-muted-foreground truncate">
            {service.image || `Build: ${service.build || "."}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {service.exposed && domainDisplay && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/10 text-[11px] font-medium text-primary">
              <Globe className="size-2.5" />
              {domainDisplay}
            </span>
          )}
          {!service.exposed && exposedPort && !isDb && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted/40 border border-dashed border-border/60 text-[11px] text-muted-foreground">
              <Globe className="size-2.5" />
              :{exposedPort}
            </span>
          )}
          {!service.exposed && exposedPort && isDb && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted/50 text-[11px] font-mono text-muted-foreground">
              <Hash className="size-2.5" />
              {exposedPort}
            </span>
          )}
          {service.dependsOn.length > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted/50 text-[11px] text-muted-foreground">
              {service.dependsOn.length} dep{service.dependsOn.length > 1 ? "s" : ""}
            </span>
          )}
          {expanded ? (
            <ChevronUp className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border/30">
          {/* Domain section — prominent, first thing */}
          <div className="px-4 pt-4 pb-3">
            <ServiceDomainSection
              service={service}
              projectName={projectName}
              onChange={onUpdate}
            />
          </div>

          {/* Meta: ports, deps, volumes — inline */}
          {(service.ports.length > 0 ||
            service.dependsOn.length > 0 ||
            service.volumes.length > 0) && (
            <div className="px-4 pb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
              {service.ports.length > 0 && (
                <>
                  {service.ports.map((p, idx) => {
                    const parts = p.split(":");
                    const host = parts.length > 1 ? parts[0] : null;
                    const container = (parts.length > 1 ? parts[1] : parts[0])?.split("/")[0];
                    return (
                      <span key={p} className="inline-flex items-center gap-1 font-mono">
                        {host && (
                          <>
                            <span className="text-foreground">{host}</span>
                            <ArrowRight className="size-3 text-muted-foreground/40" />
                          </>
                        )}
                        <span className="text-foreground">{container}</span>
                      </span>
                    );
                  })}
                </>
              )}
              {service.dependsOn.length > 0 && (
                <>
                  <span className="text-border">·</span>
                  <span>depends on{" "}
                    {service.dependsOn.map((d, i) => (
                      <React.Fragment key={d}>
                        {i > 0 && ", "}
                        <span className="font-medium text-foreground">{d}</span>
                      </React.Fragment>
                    ))}
                  </span>
                </>
              )}
              {service.volumes.length > 0 && (
                <>
                  <span className="text-border">·</span>
                  <span>{service.volumes.length} volume{service.volumes.length !== 1 ? "s" : ""}</span>
                </>
              )}
            </div>
          )}

          {/* Environment — reuse the full EnvironmentVariables component */}
          <div className="border-t border-border/30">
            <EnvironmentVariables
              mode="settings"
              showEditControls={true}
              isEditingMode={true}
              borderless
              envVars={envArray}
              onEnvVarsChange={handleEnvChange}
            />
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Main component ──────────────────────────────────────────────────────────

const ComposeServices: React.FC = () => {
  const { config, updateConfig } = useDeployment();
  const iconUrl = STACK_ICONS["docker-compose"];

  const services = config.services || [];

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

  const appCount = services.filter((s) => s.build && !isDbService(s)).length;
  const dbCount = services.filter((s) => isDbService(s)).length;
  const exposedCount = services.filter((s) => s.exposed).length;

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="px-5 py-5 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-primary/10 rounded-xl">
            {iconUrl ? (
              <img src={iconUrl} alt="Docker Compose" className="w-6 h-6" />
            ) : (
              <Layers className="w-6 h-6 text-primary" />
            )}
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-foreground">Docker Compose</h3>
            <p className="text-xs text-muted-foreground">
              {services.length} service{services.length !== 1 ? "s" : ""}
              {appCount > 0 && ` · ${appCount} app${appCount > 1 ? "s" : ""}`}
              {dbCount > 0 && ` · ${dbCount} db`}
              {exposedCount > 0 && ` · ${exposedCount} exposed`}
            </p>
          </div>
        </div>

        {/* Services list */}
        {services.length > 0 ? (
          <div className="space-y-2">
            {services.map((svc, i) => (
              <ServiceCard
                key={svc.name}
                service={svc}
                projectName={config.projectName || config.repo}
                onUpdate={(updates) => updateService(i, updates)}
                onEnvChange={(env) => updateServiceEnv(i, env)}
              />
            ))}
          </div>
        ) : (
          <div className="p-6 border-2 border-dashed border-border/50 rounded-xl bg-muted/20 text-center">
            <Layers className="size-10 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm font-medium text-foreground mb-1">
              Parsing compose file…
            </p>
            <p className="text-xs text-muted-foreground">
              Services will be detected from your docker-compose.yml
            </p>
          </div>
        )}

        {/* Info */}
        <div className="p-4 bg-muted/30 rounded-xl border border-border/50">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Internal services communicate via service names (e.g.{" "}
            <code className="text-xs font-mono text-foreground bg-muted/50 px-1 py-0.5 rounded">
              postgres://db:5432
            </code>
            ). Toggle{" "}
            <strong className="text-foreground">Public Domain</strong> on a service to expose it
            via a domain.
          </p>
        </div>
      </div>
    </div>
  );
};

export default React.memo(ComposeServices);
