"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Cloud, Cpu, GitBranch, Globe, Loader2, Pencil, Plus, RotateCcw, Search, Server, Settings2, ShieldAlert, ShieldCheck, Zap } from "lucide-react";
import {
  RESOURCE_TIER_ORDER,
  RESOURCE_TIER_SPECS,
  formatCpuCores,
  formatMemoryMb,
} from "@repo/core";
import { BlurIp } from "@/components/BlurIp";
import { useDeployment } from "@/context/DeploymentContext";
import { usesServiceDeployment } from "@/context/deployment/types";
import type { DeploymentConfig } from "@/context/deployment/types";
import { useCloud } from "@/context/CloudContext";
import { usePlatform } from "@/context/PlatformContext";
import { systemApi } from "@/lib/api/system";
import { settingsApi } from "@/lib/api/settings";
import type { ServerInfo } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";
import type { DeployTarget, BuildStrategy, CloneStrategy, RuntimeMode } from "@/context/deployment/types";
import { createPersistedValue } from "@/lib/persisted-value";
import { AddServerModal } from "./AddServerModal";
import ServerRuntimePicker from "./ServerRuntimePicker";
import { RollbackBackupPanel } from "./RollbackBackupPanel";
import { useI18n, interpolate } from "@/components/i18n-provider";

// ─── Option card ─────────────────────────────────────────────────────────────

interface OptionCardProps {
  value: string;
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
  description: string;
  /** Optional children rendered below when selected */
  children?: React.ReactNode;
  /** Extra classes for the outer wrapper - e.g. `h-full` for equal-height grids. */
  className?: string;
}

export const OptionCard: React.FC<OptionCardProps> = ({
  selected,
  onSelect,
  icon,
  label,
  description,
  children,
  className,
}) => (
  <div className={className}>
    <button
      type="button"
      onClick={onSelect}
      className={`
        relative w-full h-full text-start p-4 rounded-xl border transition-all
        ${selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
          : "border-border/50 bg-card hover:border-primary/30 hover:bg-primary/[0.02]"
        }
        ${selected && children ? "rounded-b-none border-b-0" : ""}
      `}
    >
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-lg ${selected ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground"}`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${selected ? "text-foreground" : "text-foreground/80"}`}>
            {label}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {description}
          </p>
        </div>
        {selected && (
          <div className="size-5 rounded-full bg-primary flex items-center justify-center shrink-0 mt-0.5">
            <div className="size-2 rounded-full bg-primary-foreground" />
          </div>
        )}
      </div>
    </button>
    {selected && children && (
      <div className="border border-t-0 border-primary/20 bg-primary/[0.02] rounded-b-xl px-4 pb-4 pt-2">
        {children}
      </div>
    )}
  </div>
);

// ─── Server picker (collapsed → searchable list) ─────────────────────────────

interface ServerPickerProps {
  servers: ServerInfo[];
  selectedId?: string;
  onSelect: (server: ServerInfo) => void;
  /** Renders "+ Add your own server" as the last row of the open list. */
  onAddServer?: () => void;
}

/** Server-glyph avatar + name + host line — shared by the collapsed trigger and
 *  each list row. */
const ServerRowContent: React.FC<{ server: ServerInfo; active: boolean }> = ({ server, active }) => {
  const { t } = useI18n();
  return (
    <>
      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
        active ? "bg-primary/15 text-primary" : "bg-muted/50 text-muted-foreground"
      }`}>
        <Server className="size-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">
          {server.name || server.sshHost}
          {server.isLocal && (
            <span className="ms-2 rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-medium text-info align-middle">
              {t.deploy.targetStep.thisServerBadge}
            </span>
          )}
        </p>
        <p className="text-[11px] text-muted-foreground truncate">
          {server.isLocal ? (
            t.deploy.targetStep.thisServerHost
          ) : (
            <>
              {server.sshUser || "root"}@<BlurIp>{server.sshHost}</BlurIp>:{server.sshPort || 22}
            </>
          )}
        </p>
      </div>
    </>
  );
};

const ServerPicker: React.FC<ServerPickerProps> = ({ servers, selectedId, onSelect, onAddServer }) => {
  const { t } = useI18n();
  const ts = t.deploy.targetStep;
  const selected = servers.find((s) => s.id === selectedId);
  // Collapsed once a server is chosen; auto-open to the list when none is yet
  // (so a fresh "Your servers" pick lands straight on the searchable list).
  const [open, setOpen] = useState(!selected);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // The list is a FLOATING menu (absolute), so it must dismiss itself on an
  // outside click / Escape instead of reflowing the card. Only listen while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? servers.filter((s) =>
        `${s.name ?? ""} ${s.sshUser || "root"}@${s.sshHost}:${s.sshPort || 22}`
          .toLowerCase()
          .includes(q),
      )
    : servers;

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground mb-2">{ts.chooseServer}</p>

      {/* Anchor for the floating menu. */}
      <div className="relative" ref={ref}>
        {/* Collapsed trigger — the selected server, or a placeholder. */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-start transition-all border ${
            open
              ? "border-primary/30 bg-muted/20"
              : "bg-card/60 border-border/30 hover:border-primary/20 hover:bg-muted/30"
          }`}
        >
          {selected ? (
            <ServerRowContent server={selected} active />
          ) : (
            <>
              <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 bg-muted/50 text-muted-foreground">
                <Server className="size-3.5" />
              </div>
              <span className="flex-1 text-sm text-muted-foreground">{ts.chooseServer}</span>
            </>
          )}
          <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </button>

        {/* Floating menu — absolute + elevated so it OVERLAYS the cards below
            instead of growing the container. Search box + filtered list. */}
        {open && (
          <div className="absolute inset-x-0 top-full z-50 mt-1.5 rounded-lg border border-border/60 bg-popover p-1.5 space-y-1.5 shadow-xl shadow-black/30">
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={ts.searchPlaceholder}
                autoFocus
                className="w-full ps-9 pe-3 py-2 bg-background border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>
            <div className="max-h-64 overflow-y-auto space-y-1 pe-0.5">
              {filtered.map((s) => {
                const isSelected = selectedId === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => { onSelect(s); setQuery(""); setOpen(false); }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-start transition-all ${
                      isSelected
                        ? "bg-primary/10 border border-primary/30"
                        : "bg-card/60 border border-transparent hover:border-primary/20 hover:bg-muted/30"
                    }`}
                  >
                    <ServerRowContent server={s} active={isSelected} />
                    {isSelected && <CheckCircle2 className="size-4 text-primary shrink-0" />}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">{ts.noServersMatch}</p>
              )}
            </div>
            {onAddServer && (
              <button
                type="button"
                onClick={onAddServer}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/50 px-3 py-2.5 text-[13px] text-muted-foreground transition-all hover:border-primary/40 hover:bg-muted/30 hover:text-foreground"
              >
                <Plus className="size-3.5" />
                {ts.addServer}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Compact summary (shown when editing from step 2) ────────────────────────

interface CompactSummaryProps {
  deployTarget: DeployTarget;
  buildStrategy: BuildStrategy;
  serverName?: string | null;
  showBuildStrategy?: boolean;
  /** When deployTarget is "cloud", the chosen resource tier — rendered
   *  as a small chip on the right of the summary so the operator sees
   *  their power pick at a glance without re-opening the picker. */
  cloudResourceTier?: CloudResourceTier;
  /** False when the project deploys as static files (no Start command,
   *  no long-running process). For cloud deploys this swaps the power
   *  tier chip for a "Static" chip — there's no machine to size when
   *  the workload is just files served from the edge. */
  hasServer?: boolean;
  /** Resolved runtime for a self-hosted SERVER deploy — drives a persistent
   *  chip so a user who never opens Advanced still sees whether the app runs
   *  sandboxed (Docker) or directly on the host ("bare"), the latter carrying a
   *  warning. Ignored for cloud (tier chip) and static (edge-served chip). */
  runtimeMode?: RuntimeMode;
  /** True when the project deploys as a multi-service stack (compose). A stack
   *  runs sandboxed containers — never static edge-served files — so it must
   *  never show the Static chip even when the project-level hasServer/framework
   *  is unset (those live per-service). */
  isServices?: boolean;
  /** Retention shown as its own chip. Rollback is configured inside the collapsed
   *  Advanced panel, so without this the summary bar gave no hint that retention
   *  exists at all — an operator could ship without ever learning they get
   *  restorable versions. `null`/undefined window = the auto (disk-sized) value. */
  rollbackWindow?: number | null;
  rollbackStrategy?: "git" | "snapshot";
  onEdit: () => void;
}

export const DeployTargetSummary: React.FC<CompactSummaryProps> = ({
  deployTarget,
  buildStrategy,
  serverName,
  showBuildStrategy = true,
  cloudResourceTier,
  hasServer = true,
  runtimeMode,
  isServices = false,
  rollbackWindow,
  rollbackStrategy,
  onEdit,
}) => {
  const { t } = useI18n();
  const { selfHosted } = usePlatform();
  const targetLabels: Record<DeployTarget, { label: string; icon: React.ReactNode }> = {
    local: { label: t.deploy.summary.targetLocal, icon: <Cpu className="size-3.5" /> },
    server: { label: t.deploy.summary.targetServer, icon: <Server className="size-3.5" /> },
    cloud: { label: t.deploy.summary.targetCloud, icon: <Cloud className="size-3.5" /> },
  };
  const buildLabels: Record<BuildStrategy, { label: string; icon: React.ReactNode }> = {
    local: { label: t.deploy.summary.buildLocal, icon: <Cpu className="size-3.5" /> },
    server: { label: t.deploy.summary.buildRemote, icon: <Cloud className="size-3.5" /> },
  };
  const tierLabels: Record<string, string> = {
    micro: t.deploy.power.tierMicroLabel,
    low: t.deploy.power.tierLowLabel,
    medium: t.deploy.power.tierMediumLabel,
    high: t.deploy.power.tierHighLabel,
    custom: t.deploy.power.custom,
  };
  const target = targetLabels[deployTarget];
  // Build label is driven by buildStrategy FIRST — a "local" build always runs
  // on this machine, even when the deploy target is Openship Cloud
  // (local-orchestrated cloud: build here, upload the output to the cloud
  // workspace). Only a SERVER build inherits the target's name ("Openship
  // Cloud" when the workspace builds it, else the generic remote label).
  const build =
    buildStrategy === "local"
      ? buildLabels.local
      : deployTarget === "cloud"
        ? { label: t.deploy.summary.targetCloud, icon: <Cloud className="size-3.5" /> }
        : buildLabels.server;
  const deployLabel = deployTarget === "server" && serverName
    ? serverName
    : target.label;

  // Build "destination" derived from (deployTarget, buildStrategy):
  //   - buildStrategy === "local" → local machine
  //   - buildStrategy === "server" → runs ON the deploy target
  // Same destination → collapse Build + Deploy into a single chip with
  // the two icons stacked + a `+` between them, instead of two
  // sections separated by an arrow. Most users have matching targets
  // (cloud-on-cloud, server-on-server), so this is the common case.
  const buildDest = buildStrategy === "local" ? "local" : deployTarget;
  const sameDestination = showBuildStrategy && buildDest === deployTarget;

  // Right-hand chip on the summary — one at a time, by workload shape:
  //   - Static (files served from the edge, any target): neutral info chip.
  //     No machine to size, no process to sandbox.
  //   - Cloud + server: the picked resource tier (Zap).
  //   - Self-hosted server: the runtime — "bare" carries a persistent WARNING
  //     (runs directly on the host, unsandboxed) so it's visible even when the
  //     user never opens Advanced; "docker" a neutral Sandboxed chip.
  const runtimeChip = isServices ? (
    // A service stack (compose) always runs sandboxed containers — never static
    // edge-served files — regardless of the project-level hasServer/framework
    // (which are unset for compose). Show the tier on cloud, else Sandboxed.
    deployTarget === "cloud" && cloudResourceTier ? (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground shrink-0">
        <Zap className="size-3" />
        <span>{tierLabels[cloudResourceTier] ?? cloudResourceTier}</span>
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground shrink-0">
        <ShieldCheck className="size-3" />
        {t.deploy.summary.runtimeSandboxed}
      </span>
    )
  ) : !hasServer ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground shrink-0">
      <Globe className="size-3" />
      {t.deploy.summary.runtimeStatic}
    </span>
  ) : deployTarget === "cloud" ? (
    cloudResourceTier ? (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground shrink-0">
        <Zap className="size-3" />
        <span>{tierLabels[cloudResourceTier] ?? cloudResourceTier}</span>
      </span>
    ) : null
  ) : deployTarget === "server" && runtimeMode === "bare" ? (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-medium text-warning shrink-0"
      title={t.deploy.summary.runtimeDirectHint}
    >
      <ShieldAlert className="size-3" />
      {t.deploy.summary.runtimeDirectWarning}
    </span>
  ) : deployTarget === "server" && runtimeMode === "docker" ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground shrink-0">
      <ShieldCheck className="size-3" />
      {t.deploy.summary.runtimeSandboxed}
    </span>
  ) : null;

  // Retention lives inside the collapsed Advanced panel, so surface it here as
  // its own chip — otherwise nothing on this bar hints that rollback exists.
  //
  // Gated on `selfHosted` for the same reason the Advanced panel is: on a cloud
  // instance that panel isn't rendered at all, so a chip pointing at it would
  // advertise a control the operator can't reach.
  const rollbackChip = !selfHosted ? null : (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground shrink-0"
      title={
        rollbackStrategy === "snapshot"
          ? t.deploy.summary.rollbackSnapshotHint
          : t.deploy.summary.rollbackGitHint
      }
    >
      <RotateCcw className="size-3" />
      {rollbackWindow == null
        ? t.deploy.summary.rollbackAuto
        : interpolate(
            rollbackWindow === 1
              ? t.deploy.summary.rollbackOne
              : t.deploy.summary.rollbackOther,
            { count: String(rollbackWindow) },
          )}
    </span>
  );

  return (
    <button
      type="button"
      onClick={onEdit}
      className="w-full flex items-center gap-3 px-4 py-3 bg-card rounded-xl border border-border/50 hover:border-primary/30 transition-all group"
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {sameDestination ? (
          // Merged view — single line, two icons with a + between to
          // signal "both build and deploy go here", followed by one
          // label. Saves horizontal space vs the two-section layout.
          <div className="flex items-center gap-1.5 text-sm min-w-0">
            <div className="flex items-center gap-0.5 text-muted-foreground shrink-0">
              {build.icon}
              <Plus className="size-2.5" strokeWidth={2.5} />
              {target.icon}
            </div>
            <span className="text-muted-foreground">{t.deploy.summary.buildAndDeploy}</span>
            <span className="font-medium text-foreground truncate">{deployLabel}</span>
          </div>
        ) : (
          <>
            {showBuildStrategy && (
              <>
                <div className="flex items-center gap-1.5 text-sm shrink-0">
                  {build.icon}
                  <span className="text-muted-foreground">{t.deploy.summary.build}</span>
                  <span className="font-medium text-foreground">{build.label}</span>
                </div>
                <ArrowRight className="size-3 text-muted-foreground/50 shrink-0 rtl:rotate-180" />
              </>
            )}
            <div className="flex items-center gap-1.5 text-sm min-w-0">
              {target.icon}
              <span className="text-muted-foreground">{t.deploy.summary.deploy}</span>
              <span className="font-medium text-foreground truncate">{deployLabel}</span>
            </div>
          </>
        )}
      </div>
      {runtimeChip}
      {rollbackChip}
      <Pencil className="size-3.5 text-muted-foreground transition-opacity" />
    </button>
  );
};

// ─── Hook: resolve available targets ─────────────────────────────────────────

export interface ResolvedTargets {
  ready: boolean;
  /** All configured servers */
  servers: ServerInfo[];
  hasCloudConnected: boolean;
  hasCloudOption: boolean;
  /** True when there's a real choice to make */
  hasChoice: boolean;
  /** Refetch the server list - used after returning from /servers/new */
  refreshServers: () => void;
}

export function useDesktopTargets(): ResolvedTargets {
  const cloud = useCloud();
  const { selfHosted } = usePlatform();
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [serversReady, setServersReady] = useState(false);

  // Fetch servers + filter to ones that can run apps. Exposed so the picker
  // can re-pull after the user adds a new server in another tab.
  const fetchServers = useCallback(() => {
    if (!selfHosted) {
      setServersReady(true);
      return () => {};
    }

    let cancelled = false;
    systemApi.listServers()
      .then((list) => { if (!cancelled) setServers(list); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setServersReady(true); });
    return () => { cancelled = true; };
  }, [selfHosted]);

  useEffect(() => {
    const cleanup = fetchServers();
    return cleanup;
  }, [fetchServers]);

  // Refresh when the tab regains focus - covers the "added a server in a new
  // tab" flow without forcing the user to reload the deploy page.
  useEffect(() => {
    if (!selfHosted) return;
    const onFocus = () => { fetchServers(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [selfHosted, fetchServers]);

  const hasServers = servers.length > 0;
  const hasCloudConnected = cloud.connected;
  const hasCloudOption = true;
  const ready = serversReady && !cloud.loading;

  return {
    ready,
    servers,
    hasCloudConnected,
    hasCloudOption,
    hasChoice: ready && Number(hasServers) + Number(hasCloudOption) > 1,
    refreshServers: fetchServers,
  };
}

// ─── Soft "last pick" memory ─────────────────────────────────────────────────
// Remembers the most recent deploy choice across deployments without the user
// having to opt in via "Save as default". Distinct from the settings-API
// default, which is the explicit, cross-device "always use this" setting:
// localStorage here is the soft, per-browser "what did I pick last time".
//
// Priority on seed: settings-API default > localStorage > auto-select fallback.

export type LastPick = {
  target: DeployTarget;
  serverId?: string | null;
};

export const lastPickStore = createPersistedValue<LastPick>(
  "openship.deploy-last-pick",
  (raw): raw is LastPick => {
    if (!raw || typeof raw !== "object") return false;
    const obj = raw as { target?: unknown; serverId?: unknown };
    if (obj.target !== "local" && obj.target !== "server" && obj.target !== "cloud") return false;
    if (obj.serverId !== undefined && obj.serverId !== null && typeof obj.serverId !== "string") return false;
    return true;
  },
);

// ─── Silent target seeding (used on the config view) ─────────────────────────

/**
 * Resolve the deploy target and write it to config ONCE, as soon as the target
 * list is ready — no UI. Priority mirrors the interactive step: explicit
 * settings-API default > soft localStorage last-pick > a server (prefer the
 * local host) > cloud.
 *
 * The config wizard calls this so it can land DIRECTLY on the config step with
 * the right target already in the DeployTargetSummary bar, instead of mounting
 * the full DeployTargetStep just to auto-pick a default and bounce back — that
 * async "spin then advance" was the visible flash on entry. The summary bar is
 * the affordance to change the pick (onEdit → the full step).
 *
 * `enabled` is false for existing projects: their saved target hydrates from
 * initializeFromProject and must never be overwritten by the global default.
 */
export function useSeedDeployTarget(targets: ResolvedTargets, enabled: boolean): void {
  const { updateConfig } = useDeployment();
  const appliedRef = useRef(false);
  useEffect(() => {
    if (!enabled || !targets.ready || appliedRef.current) return;
    let cancelled = false;
    const seed = (
      def?: { defaultDeployTarget?: DeployTarget | null; defaultServerId?: string | null } | null,
    ) => {
      if (cancelled || appliedRef.current) return;
      appliedRef.current = true;
      const target = def?.defaultDeployTarget ?? null;
      const savedServerId = def?.defaultServerId ?? null;
      // 1. Explicit settings-API default.
      if (target === "server" && savedServerId && targets.servers.some((s) => s.id === savedServerId)) {
        updateConfig({ deployTarget: "server", serverId: savedServerId });
        return;
      }
      if (target === "cloud") {
        updateConfig({ deployTarget: "cloud", serverId: undefined, buildStrategy: "server" });
        return;
      }
      if (target === "local") {
        updateConfig({ deployTarget: "local", serverId: undefined });
        return;
      }
      // 2. Soft last-pick, validated against the current target list.
      const last = lastPickStore.read();
      if (last?.target === "server" && last.serverId && targets.servers.some((s) => s.id === last.serverId)) {
        updateConfig({ deployTarget: "server", serverId: last.serverId });
        return;
      }
      if (last?.target === "cloud") {
        updateConfig({ deployTarget: "cloud", serverId: undefined, buildStrategy: "server" });
        return;
      }
      if (last?.target === "local") {
        updateConfig({ deployTarget: "local", serverId: undefined });
        return;
      }
      // 3. A server exists → deploy to it (prefer the local host); else cloud.
      if (targets.servers.length > 0) {
        const preferred = targets.servers.find((s) => s.isLocal) ?? targets.servers[0];
        updateConfig({ deployTarget: "server", serverId: preferred.id });
        return;
      }
      updateConfig({ deployTarget: "cloud", serverId: undefined, buildStrategy: "server" });
    };
    settingsApi.get().then((res) => seed(res)).catch(() => seed(null));
    return () => { cancelled = true; };
    // One-shot seed keyed off readiness; tight dep array on purpose (matches the
    // interactive step's seed effect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, targets.ready]);
}

// ─── Main step ───────────────────────────────────────────────────────────────

interface DeployTargetStepProps {
  /** Existing project this deploy edits, when there is one. Enables the rollback
   *  + backup controls in the Advanced panel (there's nothing to persist to for a
   *  project that hasn't been created yet). */
  projectId?: string | null;
  targets: ResolvedTargets;
  onContinue: () => void;
  /**
   * When true (the default), the step auto-advances to the next step if a
   * saved default applies cleanly - the user never sees this screen. Set to
   * false by the parent when the user explicitly navigated back here via
   * the edit affordance, so we don't bounce them straight back out.
   */
  autoSkipAllowed?: boolean;
}

// ─── Cloud resource tiers ────────────────────────────────────────────────────
// DERIVED from the one tier table in @repo/core, which the backend provisioner
// (cloud-resources.ts) and the self-hosted Machine Power card also read. These
// used to be hand-written display strings next to a comment admitting "the
// backend owns the authoritative values" — i.e. a copy that could silently drift
// from what a tier actually provisions. Label + bestFor are still looked up from
// the dictionary by `id` inside CloudPowerPicker.
type CloudResourceTier = NonNullable<DeploymentConfig["cloudResourceTier"]>;

const CLOUD_RESOURCE_TIERS: Array<{
    id: Exclude<CloudResourceTier, "custom">;
    cpu: string;
    ram: string;
    disk: string;
}> = RESOURCE_TIER_ORDER.map((id) => {
    const spec = RESOURCE_TIER_SPECS[id];
    return {
        id: id as Exclude<CloudResourceTier, "custom">,
        cpu: formatCpuCores(spec.cpuCores),
        ram: formatMemoryMb(spec.memoryMb),
        disk: formatMemoryMb(spec.diskMb),
    };
});

/** Custom starts from the middle preset rather than a second literal. */
const CUSTOM_DEFAULTS = { ...RESOURCE_TIER_SPECS.medium };

// ─── Custom-values modal ─────────────────────────────────────────────────────
// Rendered via showModal() so the inputs get proper breathing room
// instead of trying to fit beside the static spec line in a 320px card.
// Modal is portal-rendered (outside DeploymentProvider) — values are
// passed in via props rather than read from useDeployment here.
interface CustomPowerModalContentProps {
    initial: { cpuCores: number; memoryMb: number; diskMb: number };
    onSave: (values: { cpuCores: number; memoryMb: number; diskMb: number }) => void;
    onCancel: () => void;
}

const CustomPowerModalContent: React.FC<CustomPowerModalContentProps> = ({
    initial,
    onSave,
    onCancel,
}) => {
    const { t } = useI18n();
    const [values, setValues] = useState(initial);
    const set = (patch: Partial<typeof values>) =>
        setValues((prev) => ({ ...prev, ...patch }));
    return (
        <div className="p-6 space-y-5">
            <div className="space-y-1.5">
                <h3 className="text-base font-semibold text-foreground">{t.deploy.power.modalTitle}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                    {t.deploy.power.modalSubtitle}
                </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">{t.deploy.power.vcpuField}</span>
                    <input
                        type="number"
                        inputMode="decimal"
                        step="0.25"
                        min="0.25"
                        value={values.cpuCores}
                        onChange={(e) => set({ cpuCores: Number(e.target.value) || 0 })}
                        className="w-full px-3 py-2 bg-background border border-border/50 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                </label>
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">{t.deploy.power.ramField}</span>
                    <input
                        type="number"
                        inputMode="numeric"
                        step="128"
                        min="128"
                        value={values.memoryMb}
                        onChange={(e) => set({ memoryMb: Number(e.target.value) || 0 })}
                        className="w-full px-3 py-2 bg-background border border-border/50 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                </label>
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">{t.deploy.power.diskField}</span>
                    <input
                        type="number"
                        inputMode="numeric"
                        step="1"
                        min="1"
                        // Stored in MB internally; display as GB so the
                        // input matches what an operator types.
                        value={Math.round(values.diskMb / 1024)}
                        onChange={(e) =>
                            set({ diskMb: Math.max(0, Number(e.target.value) || 0) * 1024 })
                        }
                        className="w-full px-3 py-2 bg-background border border-border/50 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                </label>
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                >
                    {t.deploy.power.cancel}
                </button>
                <button
                    type="button"
                    onClick={() => onSave(values)}
                    className="px-4 py-2 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                    {t.deploy.power.save}
                </button>
            </div>
        </div>
    );
};

const CloudPowerPicker: React.FC = () => {
    const { config, updateConfig } = useDeployment();
    const { t } = useI18n();
    const { showModal, hideModal } = useModal();
    const selected = config.cloudResourceTier ?? "low";
    const custom = config.cloudResourceCustom ?? CUSTOM_DEFAULTS;
    const tierText: Record<string, { label: string; bestFor: string }> = {
        micro: { label: t.deploy.power.tierMicroLabel, bestFor: t.deploy.power.tierMicroBestFor },
        low: { label: t.deploy.power.tierLowLabel, bestFor: t.deploy.power.tierLowBestFor },
        medium: { label: t.deploy.power.tierMediumLabel, bestFor: t.deploy.power.tierMediumBestFor },
        high: { label: t.deploy.power.tierHighLabel, bestFor: t.deploy.power.tierHighBestFor },
    };

    // Collapsed by default: once a tier is chosen the list folds to a single
    // summary card; the operator expands it only to change the pick.
    const [expanded, setExpanded] = useState(false);
    const selectedTier = CLOUD_RESOURCE_TIERS.find((tr) => tr.id === selected);
    const summary =
        selected === "custom"
            ? {
                  label: t.deploy.power.custom,
                  bestFor: t.deploy.power.customDesc,
                  cpu: `${custom.cpuCores} ${t.deploy.power.vcpu}`,
                  ram: `${custom.memoryMb} MB`,
                  disk: `${Math.round(custom.diskMb / 1024)} GB`,
              }
            : {
                  label: tierText[selected]?.label ?? selected,
                  bestFor: tierText[selected]?.bestFor ?? "",
                  cpu: selectedTier?.cpu ?? "",
                  ram: selectedTier?.ram ?? "",
                  disk: selectedTier?.disk ?? "",
              };

    // Click on Custom card → open modal. Pre-selects the tier so the choice
    // sticks even if the user cancels (matches the rest of the picker:
    // clicking any tier card commits the selection). Saving from the
    // modal also writes the new values; cancel leaves them as-was.
    const openCustomModal = () => {
        updateConfig({
            cloudResourceTier: "custom",
            cloudResourceCustom: config.cloudResourceCustom ?? CUSTOM_DEFAULTS,
        });
        const id = showModal({
            maxWidth: "480px",
            customContent: (
                <CustomPowerModalContent
                    initial={config.cloudResourceCustom ?? CUSTOM_DEFAULTS}
                    onCancel={() => hideModal(id)}
                    onSave={(values) => {
                        updateConfig({
                            cloudResourceTier: "custom",
                            cloudResourceCustom: values,
                        });
                        hideModal(id);
                        setExpanded(false);
                    }}
                />
            ),
        });
    };

    return (
        // Header lives OUTSIDE the cards (matching the left column's
        // "Where do you want to deploy?" heading rhythm) so the first
        // tier card visually aligns with the first deploy option across
        // the grid row.
        <div className="space-y-3">
            <div>
                <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                    <Zap className="size-4 text-warning" />
                    {t.deploy.power.heading}
                </h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                    {t.deploy.power.subtitle}
                </p>
            </div>
            {!expanded ? (
                <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="w-full rounded-xl border border-primary bg-primary/5 ring-1 ring-primary/20 p-4 text-start transition-all hover:border-primary/60 group"
                >
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex items-baseline gap-2">
                            <span className="text-sm font-semibold shrink-0 text-foreground">{summary.label}</span>
                            <span className="text-muted-foreground/70 shrink-0">·</span>
                            <span className="text-xs text-muted-foreground truncate">{summary.bestFor}</span>
                        </div>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground shrink-0">
                            Change
                            <ChevronDown className="size-3.5" />
                        </span>
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground tabular-nums">
                        <span>{summary.cpu}</span>
                        <span className="text-muted-foreground/70">·</span>
                        <span>{t.deploy.power.ram} {summary.ram}</span>
                        <span className="text-muted-foreground/70">·</span>
                        <span>{t.deploy.power.disk} {summary.disk}</span>
                    </div>
                </button>
            ) : (
            <div className="space-y-2">
                {CLOUD_RESOURCE_TIERS.map((tier) => {
                    const isSelected = selected === tier.id;
                    return (
                        <button
                            key={tier.id}
                            type="button"
                            onClick={() => { updateConfig({ cloudResourceTier: tier.id }); setExpanded(false); }}
                            className={`w-full rounded-xl border p-4 text-start transition-all ${
                                isSelected
                                    ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                                    : "border-border/50 bg-card hover:border-primary/30 hover:bg-primary/[0.02]"
                            }`}
                        >
                            {/* Row 1 — label + description inline with a · divider. */}
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0 flex items-baseline gap-2">
                                    <span className={`text-sm font-semibold shrink-0 ${isSelected ? "text-foreground" : "text-foreground/80"}`}>
                                        {tierText[tier.id].label}
                                    </span>
                                    <span className="text-muted-foreground/70 shrink-0">·</span>
                                    <span className="text-xs text-muted-foreground truncate">
                                        {tierText[tier.id].bestFor}
                                    </span>
                                </div>
                                {isSelected && (
                                    <div className="size-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                                        <div className="size-2 rounded-full bg-primary-foreground" />
                                    </div>
                                )}
                            </div>
                            {/* Row 2 — resources with RAM / Disk labels so each
                                value reads on its own without context. */}
                            <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground tabular-nums">
                                <span>{tier.cpu}</span>
                                <span className="text-muted-foreground/70">·</span>
                                <span>{t.deploy.power.ram} {tier.ram}</span>
                                <span className="text-muted-foreground/70">·</span>
                                <span>{t.deploy.power.disk} {tier.disk}</span>
                            </div>
                        </button>
                    );
                })}

                {/* Custom — clicking the card selects it; the inline
                    inputs only appear once selected, so the collapsed
                    state stays tidy. */}
                {/* Custom — clicking opens a modal where the operator can
                    edit CPU / RAM / disk. The card itself mirrors the tier
                    layout exactly: row 1 = label · description, row 2 =
                    current values in the same `vCPU · RAM x · Disk y` shape
                    as the tier cards. Identical height, no in-card inputs
                    bleeding past the border. */}
                <button
                    type="button"
                    onClick={openCustomModal}
                    className={`w-full rounded-xl border p-4 text-start transition-all ${
                        selected === "custom"
                            ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                            : "border-border/50 bg-card hover:border-primary/30 hover:bg-primary/[0.02]"
                    }`}
                >
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex items-baseline gap-2">
                            <span className={`text-sm font-semibold shrink-0 ${selected === "custom" ? "text-foreground" : "text-foreground/80"}`}>
                                {t.deploy.power.custom}
                            </span>
                            <span className="text-muted-foreground/70 shrink-0">·</span>
                            <span className="text-xs text-muted-foreground truncate">
                                {t.deploy.power.customDesc}
                            </span>
                        </div>
                        {selected === "custom" && (
                            <div className="size-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                                <div className="size-2 rounded-full bg-primary-foreground" />
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground tabular-nums">
                        <span>{custom.cpuCores} {t.deploy.power.vcpu}</span>
                        <span className="text-muted-foreground/70">·</span>
                        <span>{t.deploy.power.ram} {custom.memoryMb} MB</span>
                        <span className="text-muted-foreground/70">·</span>
                        <span>{t.deploy.power.disk} {Math.round(custom.diskMb / 1024)} GB</span>
                    </div>
                </button>
            </div>
            )}
        </div>
    );
};

const DeployTargetStep: React.FC<DeployTargetStepProps> = ({ targets, onContinue, autoSkipAllowed = true, projectId }) => {
  const { config, updateConfig } = useDeployment();
  const { requireCloud } = useCloud();
  const { selfHosted, deployMode } = usePlatform();
  // Git credential forwarding is desktop-only — the relay forwards the
  // operator's machine-local `gh`, which only exists on a desktop host.
  const isDesktop = deployMode === "desktop";
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const ts = t.deploy.targetStep;
  const { ready, servers, hasCloudConnected, hasCloudOption, hasChoice, refreshServers } = targets;
  const hasServers = servers.length > 0;
  const isSingleServer = servers.length === 1;
  // "Save as my default for every deployment" - persists the picked target
  // (+ server id when applicable) to user_settings on continue.
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  // Whether to render the full picker vs the compact summary pill.
  // Default = full picker. Flips to compact when a saved default applies
  // cleanly. User can re-expand any time via the pencil on the pill.
  const [expanded, setExpanded] = useState(true);
  // Track when the defaults fetch is done so we can suppress the picker
  // for a brief moment instead of flashing the full picker before collapsing.
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  // Build picker lives under an "Advanced" disclosure
  // so the screen leads with the deploy-target decision. Folded by default
  // because the build strategy is correctly seeded from the user's saved
  // default — most operators never need to touch it on a per-deploy basis.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // True once the user has EXPLICITLY picked a build location from the picker.
  // The auto-match effects below (first-deploy match, cloud-switch default)
  // must never overwrite an explicit choice — otherwise "Build on this machine"
  // silently snaps back to the cloud default. Reset when the deploy target
  // changes so the sensible default applies to the new target.
  const buildStrategyTouchedRef = useRef(false);
  // Fresh server-app deploys default to Sandbox (docker). The Sandbox/Direct
  // picker now lives in the collapsed Advanced disclosure and may never mount,
  // so we can't rely on its own auto-default — seed it here instead.
  const runtimeDefaultedRef = useRef(false);

  // Add server inline via modal. On create, refresh the server list and
  // auto-select the new one so the user lands on it immediately - no extra
  // clicks, no tab juggling, deploy config stays intact.
  const openAddServer = () => {
    const id = showModal({
      width: "720px",
      maxWidth: "92vw",
      showCloseButton: false,
      customContent: (
        <AddServerModal
          onCancel={() => hideModal(id)}
          onCreated={(server) => {
            hideModal(id);
            refreshServers();
            updateConfig({ deployTarget: "server", serverId: server.id });
          }}
        />
      ),
    });
  };
  const isServiceDeployment = usesServiceDeployment(config);
  const showBuildStrategy =
    config.projectType === "app" || (config.projectType === "services" && !isServiceDeployment);

  // UNIFIED BUILD — build where you deploy, as the PERSISTENT default (every
  // untouched deploy, not just the first). A SERVER target builds on that server
  // (desktop → remote build + clone-on-server via git-credential forwarding;
  // VPS → the isLocal "This Server", i.e. build on this machine), and cloud
  // builds in the cloud runtime. Only the bare "local" target builds locally (it
  // IS the host, so buildStrategy is inert there). A server deploy that lacks a
  // clone credential still auto-downgrades to a local build at deploy time
  // (Sidebar.handleDeploy), so this never hard-fails a credential-less box. An
  // explicit pick in the Advanced disclosure (buildStrategyTouchedRef) wins.
  useEffect(() => {
    if (buildStrategyTouchedRef.current) return;
    const want: BuildStrategy = config.deployTarget === "local" ? "local" : "server";
    if (config.buildStrategy !== want) {
      updateConfig({ buildStrategy: want });
    }
  }, [config.deployTarget, config.buildStrategy, updateConfig]);

  // Sandbox (docker) is the default for a fresh self-hosted server APP. Seeded
  // once, and only when the runtime choice actually applies (server app, not
  // docker/compose/static) — never clobbers a saved project value or a choice
  // the user makes in Advanced.
  useEffect(() => {
    if (config.projectId || runtimeDefaultedRef.current) return;
    if (config.deployTarget !== "server") return;
    if (!config.options.hasServer || config.projectType === "docker" || isServiceDeployment) return;
    runtimeDefaultedRef.current = true;
    if (config.runtimeMode !== "docker") updateConfig({ runtimeMode: "docker" });
  }, [
    config.projectId,
    config.deployTarget,
    config.options.hasServer,
    config.projectType,
    isServiceDeployment,
    config.runtimeMode,
    updateConfig,
  ]);

  // Seed the picker from the user's saved default (if any). The ref makes
  // sure we only ever APPLY the default once - even under StrictMode's
  // double-mount in dev - so we never clobber a choice the user made after
  // the initial seed. The fetch itself is allowed to re-run; only the
  // current invocation's `cancelled` flag gates state updates.
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (!ready) return;
    // Existing project: its saved target is authoritative (hydrated from
    // initializeFromProject). Don't seed a default over it — just mark the
    // fetch "done" so the picker renders the current config instead of a
    // perpetual spinner. (The parent seeds NEW deploys via useSeedDeployTarget;
    // this step now only mounts when the user opens the picker via the summary
    // bar, so seeding here would fight the user's own reason for opening it.)
    if (config.projectId) {
      setDefaultsLoaded(true);
      return;
    }

    let cancelled = false;
    settingsApi.get()
      .then((res) => {
        if (cancelled) return;
        if (appliedDefaultRef.current) return; // already seeded - don't overwrite
        appliedDefaultRef.current = true;

        const target = res?.defaultDeployTarget;
        const savedServerId = res?.defaultServerId;
        let applied = false;
        if (target === "server") {
          if (savedServerId && servers.some((s) => s.id === savedServerId)) {
            updateConfig({ deployTarget: "server", serverId: savedServerId });
            applied = true;
          }
        } else if (target === "cloud") {
          updateConfig({ deployTarget: "cloud", serverId: undefined, buildStrategy: "server" });
          applied = true;
        } else if (target === "local") {
          updateConfig({ deployTarget: "local", serverId: undefined });
          applied = true;
        }

        // No explicit settings-API default? Try the soft "last pick"
        // memory from localStorage. Validate against current state - if the
        // remembered server has since been deleted, fall through.
        if (!applied) {
          const last = lastPickStore.read();
          if (last) {
            if (last.target === "server") {
              if (last.serverId && servers.some((s) => s.id === last.serverId)) {
                updateConfig({ deployTarget: "server", serverId: last.serverId });
                applied = true;
              }
            } else if (last.target === "cloud" && hasCloudOption) {
              updateConfig({ deployTarget: "cloud", serverId: undefined, buildStrategy: "server" });
              applied = true;
            } else if (last.target === "local") {
              updateConfig({ deployTarget: "local", serverId: undefined });
              applied = true;
            }
          }
        }

        // No saved default and no usable last-pick? Default to a SERVER when one
        // exists (including the auto-added "This Server" in server-host mode),
        // with a unified build — matches "deploy to your server by default".
        // Prefer the local host server. Cloud stays the fallback only when no
        // server exists at all (handled by the single-option auto-select below).
        if (!applied && servers.length > 0) {
          const preferred = servers.find((s) => s.isLocal) ?? servers[0];
          updateConfig({ deployTarget: "server", serverId: preferred.id });
          applied = true;
        }

        // Collapse to compact summary only when defaults applied cleanly
        // AND we're not coming back here on purpose. `autoSkipAllowed=false`
        // means the user clicked the edit affordance on the next step to
        // come back and change something - landing them on the compact pill
        // would force an extra click on the pencil to actually edit. Skip
        // the collapse so they see the full picker right away.
        if (applied && autoSkipAllowed) setExpanded(false);
      })
      .catch(() => { /* no default - picker falls back to auto-select */ })
      .finally(() => { if (!cancelled) setDefaultsLoaded(true); });
    return () => { cancelled = true; };
    // Excluded `servers` / `updateConfig` on purpose: this is a one-shot
    // seed keyed off `ready`. The dep array is intentionally tight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Auto-set deploy target when there's only one option
  useEffect(() => {
    if (!ready || hasChoice) {
      return;
    }

    if (hasServers) {
      updateConfig({ deployTarget: "server", serverId: servers[0].id });
      return;
    }

    if (hasCloudOption) {
      updateConfig({ deployTarget: "cloud", serverId: undefined, buildStrategy: "server" });
    }
  }, [ready, hasChoice, hasServers, hasCloudOption, servers, updateConfig]);

  // When switching TO cloud, AUTO-PRESELECT "server" as the build strategy.
  // Cloud builds belong in the cloud runtime — they get the right toolchain
  // automatically and don't burn the host's CPU/RAM. We fire this ONLY on the
  // deployTarget transition into cloud (not on every render) so a user who
  // explicitly switches to "This Machine" via the visible card AFTER the
  // switch is respected — `cloudSupportsLocalBuild` keeps that override card
  // available for stacks that produce a transferable artifact (Next.js .next,
  // Vite dist, etc.). Static-app stacks (no `hasBuild`) have nothing to
  // transfer, so the second clause force-corrects an invalid local pick.
  const prevDeployTargetRef = useRef(config.deployTarget);
  useEffect(() => {
    const justSwitchedToCloud =
      prevDeployTargetRef.current !== "cloud" && config.deployTarget === "cloud";
    prevDeployTargetRef.current = config.deployTarget;
    if (justSwitchedToCloud && config.buildStrategy !== "server") {
      updateConfig({ buildStrategy: "server" });
      return;
    }
    // Always force server-build when the stack can't produce a transferable
    // artifact - local-build would have nothing to ship to cloud.
    if (
      config.deployTarget === "cloud" &&
      config.buildStrategy === "local" &&
      config.options?.hasBuild !== true
    ) {
      updateConfig({ buildStrategy: "server" });
    }
  }, [config.deployTarget, config.buildStrategy, config.options?.hasBuild, updateConfig]);

  // Auto-select single server
  useEffect(() => {
    if (isSingleServer && config.deployTarget === "server" && !config.serverId) {
      updateConfig({ serverId: servers[0].id });
    }
  }, [isSingleServer, config.deployTarget, config.serverId, servers, updateConfig]);

  // Remember the last server actually chosen so flipping cloud↔server doesn't
  // lose it (and the runtime panel that depends on serverId). Tracks whatever
  // path set it — manual pick, single-server auto-select, add-server, default.
  const lastServerIdRef = useRef<string | undefined>(config.serverId || undefined);
  useEffect(() => {
    if (config.deployTarget === "server" && config.serverId) {
      lastServerIdRef.current = config.serverId;
    }
  }, [config.deployTarget, config.serverId]);

  const handleDeployTargetChange = (target: DeployTarget) => {
    // Changing the deploy target re-applies the sensible build default for the
    // new target; the user's previous explicit pick no longer applies.
    buildStrategyTouchedRef.current = false;
    const updates: Partial<typeof config> = { deployTarget: target };
    if (target === "cloud") {
      updates.serverId = undefined;
      updates.buildStrategy = "server";
    }
    if (target === "server") {
      // Restore the previously-chosen server (or auto-pick the only one) so the
      // runtime panel reappears instead of vanishing until a manual re-pick.
      updates.serverId =
        config.serverId ?? lastServerIdRef.current ?? (isSingleServer ? servers[0].id : undefined);
    }
    // Selection is tentative — it only updates local config. The soft "remember
    // this for next time" memory is persisted on Continue (handleContinue), not
    // on every click, so glancing at another target doesn't silently stick.
    updateConfig(updates);
  };

  const handleServerSelect = (server: ServerInfo) => {
    updateConfig({ deployTarget: "server", serverId: server.id });
  };

  // Build the deploy target options
  const deployTargetOptions: Array<{
    value: DeployTarget;
    icon: React.ReactNode;
    label: string;
    description: string;
  }> = [];

  if (hasServers) {
    if (isSingleServer) {
      // Single server → show directly by name
      deployTargetOptions.push({
        value: "server",
        icon: <Server className="size-5" />,
        label: servers[0].name || servers[0].sshHost,
        description: ts.options.serverViaSsh,
      });
    } else {
      // Multiple servers → show "Servers" category
      deployTargetOptions.push({
        value: "server",
        icon: <Server className="size-5" />,
        label: ts.options.servers,
        description: interpolate(ts.options.serversCount, { count: String(servers.length) }),
      });
    }
  }

  if (hasCloudOption) {
    deployTargetOptions.push({
      value: "cloud",
      icon: <Cloud className="size-5" />,
      label: ts.options.cloud,
      description: hasCloudConnected
        ? ts.options.cloudConnectedDesc
        : ts.options.cloudDisconnectedDesc,
    });
  }

  const buildOptions: Array<{
    value: BuildStrategy;
    icon: React.ReactNode;
    label: string;
    description: string;
  }> = [
    {
      value: "local",
      icon: <Cpu className="size-5" />,
      label: ts.build.localLabel,
      description: ts.build.localDesc,
    },
    {
      value: "server",
      icon: <Cloud className="size-5" />,
      label: ts.build.remoteLabel,
      description: ts.build.remoteDesc,
    },
  ];
  // For cloud deploys, building locally is a valid cost-saving path when the
  // stack produces a transferable build artifact (Next.js .next, Vite dist,
  // etc.). We charge for cloud build minutes; doing the build on the user's
  // machine and only shipping the output to cloud skips that cost.
  //
  // NOT default - cloud-on-cloud stays the recommended choice. Building
  // locally requires the same toolchain the cloud would use (Node version,
  // pnpm/bun/etc.) and is environment-sensitive, so we surface it as an
  // opt-in option, not the first card. Static-app stacks (no `hasBuild`)
  // can't use local-build because there's no artifact to transfer; skip.
  const cloudSupportsLocalBuild = config.options?.hasBuild === true;
  const visibleBuildOptions = config.deployTarget === "cloud"
    ? [
        {
          value: "server" as const,
          icon: <Cloud className="size-5" />,
          label: ts.build.cloudLabel,
          description: ts.build.cloudDesc,
        },
        ...(cloudSupportsLocalBuild
          ? [
              {
                value: "local" as const,
                icon: <Cpu className="size-5" />,
                label: ts.build.cloudLocalLabel,
                description: ts.build.cloudLocalDesc,
              },
            ]
          : []),
      ]
    : buildOptions;

  // Clone-location picker (DOCKER server deploys, incl. services). Bare always
  // clones on the target, so it keeps the credential-forwarding checkbox below
  // instead — there's no "clone on the API host" alternative for it. Cloud
  // clones inside the workspace and local has no remote, so both are excluded.
  // Services always deploy as docker (build on the server), so the clone picker
  // applies to them regardless of the config.runtimeMode field (which may not be
  // hydrated to "docker" on a config-edit).
  // Clone location only exists for a REMOTE build (the clone runs on the target).
  // "This Machine" (local build) clones + builds here and ships the output, so
  // there's no on-server-vs-here choice to make — hide it entirely.
  const showCloneStrategy =
    config.deployTarget === "server" &&
    config.buildStrategy === "server" &&
    (config.runtimeMode === "docker" || isServiceDeployment);
  // Clone-on-server is the default (primary card); cloning on the api host and
  // uploading is the advanced/manual alternative.
  const cloneStrategy: CloneStrategy = config.cloneStrategy ?? "server";
  const cloneOptions: Array<{
    value: CloneStrategy;
    icon: React.ReactNode;
    label: string;
    description: string;
  }> = [
    {
      value: "server",
      icon: <GitBranch className="size-5" />,
      label: ts.clone.serverLabel,
      description: ts.clone.serverDesc,
    },
    {
      value: "api-host",
      // The "api host" is the machine running Openship: the user's own device in
      // desktop mode, the Openship orchestrator when self-hosted. Not the cloud —
      // so no cloud icon, and a label that says which machine it actually is.
      icon: <Cpu className="size-5" />,
      label: isDesktop ? ts.clone.apiHostDesktopLabel : ts.clone.apiHostServerLabel,
      description: isDesktop
        ? ts.clone.apiHostDesktopDesc
        : ts.clone.apiHostServerDesc,
    },
  ];

  // Default the clone location to "on the server" for a brand-new deploy when
  // the choice is UNSET. Git-identity forwarding is no longer a per-deploy
  // choice — it's the operator-wide "Forward my git identity to build servers"
  // setting (Settings → Clone credentials), resolved server-side at build time.
  useEffect(() => {
    if (config.projectId) return;
    if (!showCloneStrategy) return;
    if (config.cloneStrategy == null) updateConfig({ cloneStrategy: "server" });
  }, [config.projectId, showCloneStrategy, config.cloneStrategy, updateConfig]);


  const hasAnyDeployTarget = deployTargetOptions.length > 0;
  const canContinue = ready && (
    config.deployTarget === "cloud" ||
    (config.deployTarget === "server" && !!config.serverId && hasServers)
  );

  // Auto-skip eligibility - true when a saved default has applied cleanly
  // AND the parent allows skipping. While true, we want to bypass the UI
  // entirely (no flash of compact summary before onContinue fires).
  const baseLoading = !ready || !defaultsLoaded;
  const baseCompactEligible = !baseLoading && !expanded && canContinue;
  const wouldAutoSkip = autoSkipAllowed && baseCompactEligible;

  // Render flags. When we're about to auto-skip, keep showing the loading
  // spinner so the user sees a single transition (spinner → next step)
  // instead of (spinner → compact pill → next step).
  const showLoading = baseLoading || wouldAutoSkip;
  const useCompact = !showLoading && baseCompactEligible;
  const showFullPicker = !showLoading && !useCompact;

  // Auto-skip the entire step when a saved default applies cleanly. Parent
  // sets autoSkipAllowed=false when the user navigated back here on purpose,
  // so this only fires on the initial entry. Ref prevents StrictMode and
  // re-render double-fires; once we've handed off to onContinue we're done.
  const autoSkippedRef = useRef(false);
  useEffect(() => {
    if (!wouldAutoSkip) return;
    if (autoSkippedRef.current) return;
    autoSkippedRef.current = true;
    onContinue();
  }, [wouldAutoSkip, onContinue]);

  // Server name for the compact pill - falls back to host if unnamed.
  const selectedServer = config.deployTarget === "server" && config.serverId
    ? servers.find((s) => s.id === config.serverId)
    : null;
  const summaryServerName = selectedServer
    ? (selectedServer.name || selectedServer.sshHost)
    : null;

  // Persist the current pick as the user's default - fire-and-forget so it
  // never blocks the deploy flow. Failures are surfaced as a toast; the
  // deploy itself continues either way.
  const persistDefault = async () => {
    if (!saveAsDefault) return;
    setSavingDefault(true);
    try {
      await settingsApi.updateDeployDefaults({
        defaultDeployTarget: config.deployTarget,
        defaultServerId: config.deployTarget === "server" ? (config.serverId ?? null) : null,
      });
      showToast(ts.savedToast, "success", ts.savedToastTitle);
    } catch {
      showToast(ts.saveFailedToast, "error", ts.savedToastTitle);
    } finally {
      setSavingDefault(false);
    }
  };

  const handleContinue = async () => {
    // The only hard gate at this step: deploying TO Openship Cloud needs an
    // Openship Cloud connection. Anything else (free .${baseDomain} domains
    // on own-server / local, free domains in compose services, etc.) is a
    // downstream concern - the stack/domains screens after Continue prompt
    // for cloud at the exact moment it's actually needed. Interrupting here
    // is paternalistic and breaks the "I picked my own server, leave me
    // alone" signal the user just gave us.
    if (config.deployTarget === "cloud" && !hasCloudConnected) {
      if (!(await requireCloud("cloud-deploy-target"))) {
        return;
      }
    }

    // Persist the soft "remember this target for next time" memory now — on
    // commit, not on every tentative click. This is what lets a returning user
    // skip straight to config next deploy.
    lastPickStore.write({
      target: config.deployTarget,
      serverId: config.deployTarget === "server" ? (config.serverId ?? null) : null,
    });

    void persistDefault();
    onContinue();
  };

  // Right-column "how it runs" panel: cloud → power/resource picker; a
  // self-hosted SERVER app → runtime-isolation (Sandbox/Direct) picker. Both
  // lay the step out as 2 columns (existing flow left, panel right). Anything
  // else (local, static, docker/compose, compact summary, loading) stays
  // single-column. This component owns its own max-width (below) so the parent
  // page just centers it — the two-column layout needs the wide track, the
  // single-column onboarding stays narrow.
  const showCloudPicker = showFullPicker && config.deployTarget === "cloud";
  // Server runtime / build / clone knobs now live under ONE collapsed "Advanced"
  // disclosure in the main column instead of an always-open right panel — the
  // main screen is just "where to deploy", details one click away. Default is
  // Sandbox; most users never open this. Only cloud keeps a right-hand panel
  // (its resource/power picker).
  const showServerAdvanced =
    showFullPicker && config.deployTarget === "server" && !!config.serverId;
  // Runtime-isolation (Sandbox/Direct) applies only to a self-hosted server APP
  // that runs a process: docker/compose always run sandboxed, and a static app
  // (files served by the edge, hasServer=false) has nothing to isolate. Shown in
  // the Advanced panel (right column).
  const showRuntimeIsolation =
    config.options.hasServer &&
    config.projectType !== "docker" &&
    !isServiceDeployment;
  const showRightPanel = showCloudPicker || showServerAdvanced;
  // Self-hosted server layout: the server/cloud choice is the MAIN wide column on
  // the LEFT; Advanced is a collapsed RAIL on the right. Opening Advanced EXCHANGES
  // the column widths — the server column shrinks to the rail width and Advanced
  // grows to fill (positions stay fixed; only the grid track widths trade, with a
  // transition). So the screen leads with "where to deploy" and the build/clone/
  // runtime detail expands into the space only when asked for. Cloud keeps its own
  // right-hand power panel; single-column onboarding is untouched.
  const serverLayout = showServerAdvanced;

  // Advanced-panel summary line. Says WHAT'S INSIDE, not just the build location:
  // a collapsed panel labelled only "Build on Remote" hides the rollback window
  // and the clone location, so there's no way to know they're in there.
  const advancedSections = [
    showRuntimeIsolation ? t.deploy.runtime.heading : null,
    showBuildStrategy
      ? interpolate(ts.build.advancedSummary, {
          action: config.options.hasBuild ? ts.build.actionBuild : ts.build.actionPrepare,
          location: visibleBuildOptions.find((o) => o.value === config.buildStrategy)?.label ?? "—",
        })
      : null,
    ts.rollbackTitle,
    showCloneStrategy ? ts.clone.heading : null,
  ].filter(Boolean) as string[];

  // Action controls (extracted so they can live in the left column on a single-
  // column layout, or move into the right column — above the Advanced/Cloud
  // panel — when a right panel is shown: Continue → save-default → Advanced).
  const saveDefaultCheckbox =
    showFullPicker && canContinue ? (
      <label className="flex items-start gap-2.5 cursor-pointer select-none px-1">
        <input
          type="checkbox"
          checked={saveAsDefault}
          onChange={(e) => setSaveAsDefault(e.target.checked)}
          disabled={savingDefault}
          className="mt-0.5 size-4 shrink-0 rounded border-border/60 bg-card text-primary focus:ring-2 focus:ring-primary/30 focus:ring-offset-0 cursor-pointer disabled:opacity-50"
        />
        <span className="text-sm text-muted-foreground leading-snug">
          {ts.saveDefault}{" "}
          <span className="text-muted-foreground/70">{ts.saveDefaultHint}</span>
        </span>
      </label>
    ) : null;

  // Shared Continue styling. In the two-column layout it fills the right
  // ("advanced") column (see the header grid below); single-column keeps it
  // auto-width on the right of the header row.
  const continueBtnClass =
    "inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none";
  const continueLabel = (
    <>
      {ts.continue}
      <ArrowRight className="size-4 rtl:rotate-180" />
    </>
  );

  // Unified header — title + subtitle (left) and Continue (right). When a right
  // ("advanced") panel is shown the header mirrors the body's column template
  // exactly, so Continue starts at the divider and spans the advanced column,
  // sitting directly above that panel instead of floating at the far edge.
  const headerTitle = useCompact ? ts.deployAndBuildHeading : ts.heading;
  const headerSubtitle = showLoading
    ? ts.loadingSubtitle
    : useCompact
      ? null
      : hasAnyDeployTarget
        ? hasChoice
          ? ts.chooseSubtitle
          : ts.onlyOneSubtitle
        : ts.noTargetSubtitle;
  const headerTitleBlock = (
    <div className="min-w-0">
      <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
        {headerTitle}
      </h1>
      {headerSubtitle && <p className="text-sm text-muted-foreground/70 mt-1">{headerSubtitle}</p>}
    </div>
  );
  const header = showRightPanel && !serverLayout ? (
    // Cloud: mirror the body grid track (gap-0 on lg) so Continue lines up
    // pixel-for-pixel with the power panel underneath it. The swapped server
    // layout uses the plain flex header below instead (Continue top-right, above
    // the server rail), since its columns are reordered.
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_1px_320px] lg:gap-0 lg:items-start">
      <div className="lg:pe-6">{headerTitleBlock}</div>
      <div className="hidden lg:block" aria-hidden />
      <div className="lg:ps-6">
        <button type="button" onClick={handleContinue} disabled={!canContinue} className={`w-full ${continueBtnClass}`}>
          {continueLabel}
        </button>
      </div>
    </div>
  ) : (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      {headerTitleBlock}
      <button type="button" onClick={handleContinue} disabled={!canContinue} className={`shrink-0 ${continueBtnClass}`}>
        {continueLabel}
      </button>
    </div>
  );

  return (
    <div className={`mx-auto w-full space-y-8 ${showRightPanel ? "max-w-5xl" : "max-w-lg"}`}>
      {header}
      <div
        className={
          !showRightPanel
            ? ""
            : serverLayout
              ? // Server layout: flex row so the two columns can TRADE widths with a
                // real width transition (grid-template-columns won't interpolate
                // fr↔px, so it snapped). Stacks on mobile.
                "space-y-8 lg:space-y-0 lg:flex lg:items-start"
              : "grid grid-cols-1 gap-0 items-start lg:grid-cols-[minmax(0,1fr)_1px_320px]"
        }
      >
    {/* "Where" cell — deploy target + server picker. Always the LEFT column; the
        wide main until Advanced opens, then it shrinks to the rail width (the
        Advanced column grows to fill — an animated width exchange). */}
    <div
      className={
        serverLayout
          ? `space-y-8 min-w-0 lg:pe-6 lg:shrink-0 lg:transition-[width] lg:duration-300 lg:ease-out ${
              advancedOpen ? "lg:w-[360px]" : "lg:w-[calc(100%-361px)]"
            }`
          : `space-y-8 min-w-0 ${showRightPanel ? "lg:pe-6" : ""}`
      }
    >
      {showLoading && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border/50 bg-card px-4 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {ts.loadingCheck}
        </div>
      )}

      {/* Compact summary - saved default applied cleanly. The pill itself
          is the edit affordance: clicking expands the full picker so the
          user can change build/deploy for this one deployment. */}
      {useCompact && (
        <DeployTargetSummary
          deployTarget={config.deployTarget}
          buildStrategy={config.buildStrategy}
          serverName={summaryServerName}
          showBuildStrategy={showBuildStrategy}
          hasServer={config.options.hasServer}
          runtimeMode={config.runtimeMode}
          isServices={config.projectType === "services" || config.serviceDeploymentMode === "services"}
          onEdit={() => setExpanded(true)}
        />
      )}

      {/* Deploy target */}
      {showFullPicker && hasAnyDeployTarget && (
        <div className="space-y-3">
          <div className="space-y-2">
            {deployTargetOptions.map((opt) => (
              <OptionCard
                key={opt.value}
                value={opt.value}
                selected={config.deployTarget === opt.value}
                onSelect={() => handleDeployTargetChange(opt.value)}
                icon={opt.icon}
                label={opt.label}
                description={opt.description}
              >
                {/* Collapsed, searchable picker for multiple servers — carries
                    its own "Add your own server" row inside the open list. */}
                {opt.value === "server" && !isSingleServer && config.deployTarget === "server" && (
                  <ServerPicker
                    servers={servers}
                    selectedId={config.serverId}
                    onSelect={handleServerSelect}
                    onAddServer={selfHosted ? openAddServer : undefined}
                  />
                )}
              </OptionCard>
            ))}
          </div>
          {/* External add-server button only when the picker (which now owns it)
              isn't shown — i.e. cloud selected, or the single-server case. */}
          {selfHosted && !(config.deployTarget === "server" && !isSingleServer) && (
            <button
              type="button"
              onClick={openAddServer}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 bg-card/40 px-4 py-2.5 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground hover:bg-muted/30 transition-all"
            >
              <Plus className="size-3.5" />
              {ts.addServer}
            </button>
          )}

        </div>
      )}

      {showFullPicker && !hasAnyDeployTarget && (
        <div className="space-y-3">
          <div className="rounded-xl border border-border/50 bg-card px-4 py-4 text-sm text-muted-foreground leading-relaxed">
            {ts.noTargetBody}
          </div>
          {selfHosted && (
            <button
              type="button"
              onClick={openAddServer}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 bg-card/40 px-4 py-2.5 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground hover:bg-muted/30 transition-all"
            >
              <Plus className="size-3.5" />
              {ts.addServer}
            </button>
          )}
        </div>
      )}

      {/* "How it's served" (static vs server process + start command) is NOT here —
          it lives with the app's build settings (the "Start" toggle), so the deploy
          step stays about WHERE to deploy, not how the app is built/served. */}

      {/* Advanced (Sandbox/Direct, build location, clone, git-forward) renders
          as a compact panel in the RIGHT column for server deploys — see the
          right-panel block below. Continue lives in the unified header. */}

      {/* save-default sits with the target picker: single-column, or the swap's
          server rail. For cloud it lives in the right power column instead. */}
      {(!showRightPanel || serverLayout) && saveDefaultCheckbox}
    </div>
    {showRightPanel && (
      <>
        {/* Vertical divider between the two columns. */}
        <div className="hidden lg:block w-px bg-border self-stretch lg:shrink-0" />
        {/* "How" column (right) — the Advanced disclosure (server) or the cloud
            power picker. For a server it's a rail (360px) that grows to fill when
            opened, trading widths with the server column via a width transition. */}
        <div
          key={config.deployTarget}
          className={
            serverLayout
              ? `min-w-0 space-y-6 animate-slide-in-right lg:ps-6 lg:shrink-0 lg:transition-[width] lg:duration-300 lg:ease-out ${
                  advancedOpen ? "lg:w-[calc(100%-361px)]" : "lg:w-[360px]"
                }`
              : "min-w-0 space-y-6 animate-slide-in-right lg:ps-6"
          }
        >
          {/* Cloud carries the save-default toggle here; the swap moved it into
              the server rail (left cell above). */}
          {!serverLayout && saveDefaultCheckbox}
          {showCloudPicker && <CloudPowerPicker />}
          {showServerAdvanced && (
            <div className="rounded-2xl border border-border/50 bg-card">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-start"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/40">
                    <Settings2 className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">{ts.build.advanced}</p>
                    {/* Each section as its own wrapping chip, NOT one joined line.
                        Joined + `truncate` in this narrow column cut the list off
                        mid-word ("Rollback & backups · Cl…"), so the panel hid the
                        very sections the summary exists to advertise. */}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {advancedSections.map((section) => (
                        <span
                          key={section}
                          className="rounded-md bg-muted/50 px-1.5 py-0.5 text-[11px] leading-tight text-muted-foreground"
                        >
                          {section}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                {advancedOpen ? (
                  <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                )}
              </button>

              {/* Accordion: animate the content's HEIGHT (grid-rows 0fr→1fr) so it
                  doesn't pop in. Always mounted so the transition has something to
                  reveal; the inner content fades in as it grows. */}
              <div
                className={`grid transition-[grid-template-rows] duration-300 ease-out ${
                  advancedOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                }`}
              >
                <div
                  className={`overflow-hidden transition-opacity duration-200 ${
                    advancedOpen ? "opacity-100 delay-100" : "opacity-0"
                  }`}
                >
                  <div className="border-t border-border/50 px-4 py-4 space-y-5">
                  {/* Runtime isolation — Sandbox (default) vs Direct. Server app only. */}
                  {showRuntimeIsolation && <ServerRuntimePicker enabled={advancedOpen} />}

                  {/* Build location — where the clone + build run. */}
                  {showBuildStrategy && (
                    <div className="space-y-3">
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">
                          {config.options.hasBuild ? ts.build.heading : ts.build.prepareHeading}
                        </h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {config.options.hasBuild ? ts.build.subtitle : ts.build.prepareSubtitle}
                        </p>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 items-stretch">
                        {visibleBuildOptions.map((opt) => (
                          <OptionCard
                            key={opt.value}
                            value={opt.value}
                            selected={config.buildStrategy === opt.value}
                            onSelect={() => {
                              buildStrategyTouchedRef.current = true;
                              updateConfig({ buildStrategy: opt.value });
                            }}
                            icon={opt.icon}
                            label={opt.label}
                            description={opt.description}
                            className="h-full"
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Rollback window + backup summary for the chosen target. The
                      same retention controls the project's Git settings show. */}
                  <RollbackBackupPanel
                    projectId={projectId}
                    enabled={advancedOpen}
                    // A static project (nothing runs as a process) retains built
                    // FILES, not images — the same distinction the "Static ·
                    // edge-served" chip on the summary makes.
                    artifactKind={!config.options.hasServer && !isServiceDeployment ? "files" : "image"}
                  />

                  {/* Clone location — docker/compose server deploys (sandboxed). */}
                  {showCloneStrategy && (
                    <div className="space-y-3">
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">
                          {ts.clone.heading}
                        </h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {ts.clone.descLead}
                          {isDesktop ? ts.clone.descDesktop : ts.clone.descServer}
                        </p>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 items-stretch">
                        {cloneOptions.map((opt) => (
                          <OptionCard
                            key={opt.value}
                            value={opt.value}
                            selected={cloneStrategy === opt.value}
                            onSelect={() => updateConfig({ cloneStrategy: opt.value })}
                            icon={opt.icon}
                            label={opt.label}
                            description={opt.description}
                            className="h-full"
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </>
    )}
      </div>
    </div>
  );
};

export default DeployTargetStep;
