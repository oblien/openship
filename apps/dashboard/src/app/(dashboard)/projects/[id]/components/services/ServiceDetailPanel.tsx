"use client";

import React, { useState } from "react";
import { usePlatform } from "@/context/PlatformContext";
import { servicesApi, type Service, type ServiceContainer } from "@/lib/api/services";
import {
  X,
  Play,
  Square,
  RefreshCw,
  Globe,
  Terminal,
  Variable,
  Container,
  Loader2,
  Network,
  Hash,
  ExternalLink,
  Power,
  RotateCw,
  Eye,
  EyeOff,
  Link2,
  Layers,
} from "lucide-react";

/* ── Props ──────────────────────────────────────────────────────────── */

interface ServiceDetailPanelProps {
  service: Service;
  container?: ServiceContainer;
  projectId: string;
  onClose: () => void;
  onRefresh: () => void;
}

/* ── Panel ──────────────────────────────────────────────────────────── */

export function ServiceDetailPanel({
  service,
  container,
  projectId,
  onClose,
  onRefresh,
}: ServiceDetailPanelProps) {
  const { baseDomain } = usePlatform();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const status = container?.status ?? (service.enabled ? "stopped" : "disabled");

  const resolvedUrl = service.exposed
    ? service.domainType === "custom" && service.customDomain
      ? `https://${service.customDomain}`
      : service.domain
        ? `https://${service.domain}.${baseDomain}`
        : null
    : null;

  /* ── Handlers ───────────────────────────────────────────────── */

  const handleContainerAction = async (action: "start" | "stop" | "restart") => {
    setActionLoading(action);
    try {
      if (action === "start") await servicesApi.start(projectId, service.id);
      else if (action === "stop") await servicesApi.stop(projectId, service.id);
      else await servicesApi.restart(projectId, service.id);
      onRefresh();
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggleEnabled = async () => {
    setSaving(true);
    try {
      await servicesApi.update(projectId, service.id, { enabled: !service.enabled });
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleToggleExposed = async () => {
    setSaving(true);
    try {
      await servicesApi.update(projectId, service.id, { exposed: !service.exposed });
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleDomainTypeChange = async (domainType: "free" | "custom") => {
    setSaving(true);
    try {
      await servicesApi.update(projectId, service.id, { domainType });
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleDomainSave = async (field: "domain" | "customDomain", value: string) => {
    setSaving(true);
    try {
      await servicesApi.update(projectId, service.id, { [field]: value });
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleExposedPortSave = async (port: string) => {
    setSaving(true);
    try {
      await servicesApi.update(projectId, service.id, { exposedPort: port });
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
        <div className="w-9 h-9 rounded-xl bg-muted/60 flex items-center justify-center shrink-0">
          <Container className="size-[18px] text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-foreground truncate">{service.name}</h3>
            <StatusBadge status={status} />
          </div>
          <p className="text-[12px] text-muted-foreground truncate mt-0.5">
            {service.image || service.build || "—"}
          </p>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-foreground/[0.06] transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="divide-y divide-border/30">
        {/* ── Status & Actions ──────────────────────────────────── */}
        <Section title="Status" icon={Power}>
          <div className="flex items-center gap-2 flex-wrap">
            {container?.containerId ? (
              <>
                {status === "running" && (
                  <>
                    <ActionButton icon={Square} label="Stop" loading={actionLoading === "stop"} onClick={() => handleContainerAction("stop")} variant="danger" />
                    <ActionButton icon={RotateCw} label="Restart" loading={actionLoading === "restart"} onClick={() => handleContainerAction("restart")} variant="warning" />
                  </>
                )}
                {status === "stopped" && (
                  <ActionButton icon={Play} label="Start" loading={actionLoading === "start"} onClick={() => handleContainerAction("start")} variant="success" />
                )}
              </>
            ) : (
              <p className="text-[12px] text-muted-foreground">No container running.</p>
            )}

            <div className="ml-auto">
              <button
                onClick={handleToggleEnabled}
                disabled={saving}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-medium transition-colors disabled:opacity-50 ${
                  service.enabled
                    ? "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
                    : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
                }`}
              >
                {saving ? <Loader2 className="size-3 animate-spin" /> : <Power className="size-3" />}
                {service.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          </div>
        </Section>

        {/* ── Routing ───────────────────────────────────────────── */}
        <Section title="Routing" icon={Globe}>
          {/* Expose toggle */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {service.exposed ? <Eye className="size-3.5 text-blue-500" /> : <EyeOff className="size-3.5 text-muted-foreground" />}
              <span className="text-[13px] font-medium text-foreground">
                {service.exposed ? "Publicly exposed" : "Internal only"}
              </span>
            </div>
            <Toggle enabled={service.exposed} onChange={handleToggleExposed} disabled={saving} />
          </div>

          {/* Domain configuration */}
          {service.exposed && (
            <div className="space-y-3 mt-3 pt-3 border-t border-border/20">
              {/* Type tabs */}
              <div className="flex items-center gap-2">
                <TabButton active={service.domainType !== "custom"} disabled={saving} onClick={() => handleDomainTypeChange("free")}>
                  Free subdomain
                </TabButton>
                <TabButton active={service.domainType === "custom"} disabled={saving} onClick={() => handleDomainTypeChange("custom")}>
                  Custom domain
                </TabButton>
              </div>

              {/* Domain input */}
              {service.domainType === "custom" ? (
                <InlineInput value={service.customDomain ?? ""} placeholder="app.example.com" saving={saving} onSave={(v) => handleDomainSave("customDomain", v)} />
              ) : (
                <InlineInput value={service.domain ?? ""} suffix={`.${baseDomain}`} placeholder="my-service" saving={saving} onSave={(v) => handleDomainSave("domain", v)} />
              )}

              {/* Exposed port */}
              <PortPicker value={service.exposedPort ?? ""} ports={service.ports} saving={saving} onSave={handleExposedPortSave} />

              {/* Live URL */}
              {resolvedUrl && (
                <div className="flex items-center gap-2">
                  <Link2 className="size-3.5 text-emerald-500" />
                  <a href={resolvedUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-blue-500 dark:text-blue-400 hover:underline flex items-center gap-1">
                    {resolvedUrl.replace("https://", "")}
                    <ExternalLink className="size-3" />
                  </a>
                </div>
              )}
            </div>
          )}
        </Section>

        {/* ── Network ───────────────────────────────────────────── */}
        {(container?.containerId || (service.ports && service.ports.length > 0)) && (
          <Section title="Network" icon={Network}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {service.ports && service.ports.length > 0 && <InfoRow icon={Globe} label="Ports" value={service.ports.join(", ")} />}
              {container?.hostPort && <InfoRow icon={Hash} label="Host Port" value={String(container.hostPort)} />}
              {container?.ip && <InfoRow icon={Network} label="Container IP" value={container.ip} />}
              {container?.containerId && <InfoRow icon={Container} label="Container" value={container.containerId.slice(0, 12)} />}
            </div>
          </Section>
        )}

        {/* ── Configuration ─────────────────────────────────────── */}
        {(service.restart || service.command || (service.dependsOn && service.dependsOn.length > 0)) && (
          <Section title="Configuration" icon={Terminal}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {service.restart && <InfoRow icon={RefreshCw} label="Restart" value={service.restart} />}
              {service.command && <InfoRow icon={Terminal} label="Command" value={service.command} />}
              {service.dependsOn && service.dependsOn.length > 0 && <InfoRow icon={Layers} label="Depends On" value={service.dependsOn.join(", ")} />}
            </div>
          </Section>
        )}

        {/* ── Environment ───────────────────────────────────────── */}
        {service.environment && Object.keys(service.environment).length > 0 && (
          <Section title={`Environment (${Object.keys(service.environment).length})`} icon={Variable}>
            <div className="rounded-xl bg-muted/30 border border-border/40 px-3 py-2 space-y-1 max-h-48 overflow-y-auto">
              {Object.entries(service.environment).map(([k, v]) => (
                <div key={k} className="flex items-baseline gap-2 text-[12px] font-mono">
                  <span className="text-foreground/80 shrink-0">{k}</span>
                  <span className="text-muted-foreground">=</span>
                  <span className="text-muted-foreground truncate">{v}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── Volumes ───────────────────────────────────────────── */}
        {service.volumes && service.volumes.length > 0 && (
          <Section title="Volumes" icon={Terminal}>
            <div className="rounded-xl bg-muted/30 border border-border/40 px-3 py-2 space-y-1">
              {service.volumes.map((vol) => (
                <p key={vol} className="text-[12px] font-mono text-muted-foreground truncate">{vol}</p>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

/* ── Primitives ─────────────────────────────────────────────────────── */

function Section({ title, icon: Icon, children }: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="px-5 py-4 space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">{title}</span>
      </div>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { dot: string; badge: string; label: string }> = {
    running: { dot: "bg-emerald-500", badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", label: "Running" },
    stopped: { dot: "bg-muted-foreground/30", badge: "bg-muted/60 text-muted-foreground/70", label: "Stopped" },
    disabled: { dot: "bg-muted-foreground/20", badge: "bg-muted/40 text-muted-foreground/50", label: "Disabled" },
    failed: { dot: "bg-red-500", badge: "bg-red-500/10 text-red-600 dark:text-red-400", label: "Failed" },
    starting: { dot: "bg-amber-500", badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400", label: "Starting" },
  };
  const s = map[status] ?? map.stopped;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${s.badge}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function ActionButton({ icon: Icon, label, loading, onClick, variant }: {
  icon: React.ComponentType<{ className?: string }>; label: string; loading: boolean; onClick: () => void; variant: "success" | "danger" | "warning";
}) {
  const colors = {
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20",
    danger: "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20",
  };
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} disabled={loading}
      className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-colors disabled:opacity-50 ${colors[variant]}`}>
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
      {label}
    </button>
  );
}

function Toggle({ enabled, onChange, disabled }: { enabled: boolean; onChange: () => void; disabled: boolean }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onChange(); }} disabled={disabled}
      className={`relative rounded-full transition-colors duration-200 ${enabled ? "bg-blue-500" : "bg-muted-foreground/20"}`}
      style={{ height: "22px", width: "40px" }}>
      <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ${enabled ? "translate-x-[18px]" : "translate-x-0"}`} />
    </button>
  );
}

function TabButton({ active, disabled, onClick, children }: { active: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${active ? "bg-primary/10 text-primary" : "bg-muted/40 text-muted-foreground hover:bg-muted/60"}`}>
      {children}
    </button>
  );
}

function InlineInput({ value, suffix, placeholder, saving, onSave }: {
  value: string; suffix?: string; placeholder: string; saving: boolean; onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const changed = draft !== value;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 flex items-center rounded-lg border border-border/50 bg-muted/20 overflow-hidden">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder}
          className="flex-1 px-2.5 py-1.5 text-[12px] bg-transparent outline-none text-foreground placeholder:text-muted-foreground/40" />
        {suffix && <span className="text-[12px] text-muted-foreground pr-2.5 shrink-0">{suffix}</span>}
      </div>
      {changed && (
        <button onClick={() => onSave(draft)} disabled={saving}
          className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
          {saving ? <Loader2 className="size-3 animate-spin" /> : "Save"}
        </button>
      )}
    </div>
  );
}

function PortPicker({ value, ports, saving, onSave }: {
  value: string; ports: string[] | null; saving: boolean; onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const changed = draft !== value;
  const portOptions = (ports ?? []).map((p) => { const parts = p.split(":"); return parts.length === 2 ? parts[1] : parts[0]; });

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5">
        <Hash className="size-3 text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">Exposed port</span>
      </div>
      {portOptions.length > 0 ? (
        <select value={draft} onChange={(e) => { setDraft(e.target.value); if (e.target.value !== value) onSave(e.target.value); }} disabled={saving}
          className="px-2 py-1 rounded-lg text-[12px] bg-muted/30 border border-border/40 text-foreground outline-none">
          <option value="">Auto</option>
          {portOptions.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      ) : (
        <div className="flex items-center gap-2">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="3000"
            className="w-20 px-2 py-1 rounded-lg text-[12px] bg-muted/30 border border-border/40 text-foreground outline-none" />
          {changed && (
            <button onClick={() => onSave(draft)} disabled={saving}
              className="px-2 py-1 rounded-lg text-[11px] font-medium bg-primary text-primary-foreground disabled:opacity-50">
              {saving ? <Loader2 className="size-3 animate-spin" /> : "Save"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function InfoRow({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon className="size-3.5 text-muted-foreground shrink-0" />
      <span className="text-[12px] text-muted-foreground shrink-0">{label}</span>
      <span className="text-[12px] font-medium text-foreground truncate">{value}</span>
    </div>
  );
}
