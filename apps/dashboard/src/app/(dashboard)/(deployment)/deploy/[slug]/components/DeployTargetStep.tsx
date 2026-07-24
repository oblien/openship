"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { Server, Cloud, Cpu, ArrowRight, Pencil, ChevronDown, ChevronUp, CheckCircle2, Loader2, Plus, Settings2, Zap, Globe, GitBranch, Search } from "lucide-react";
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
import type { DeployTarget, BuildStrategy, CloneStrategy } from "@/context/deployment/types";
import { createPersistedValue, createPersistedFlag } from "@/lib/persisted-value";
import { AddServerModal } from "./AddServerModal";
import ServerRuntimePicker from "./ServerRuntimePicker";
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
          {server.isLocal
            ? t.deploy.targetStep.thisServerHost
            : `${server.sshUser || "root"}@${server.sshHost}:${server.sshPort || 22}`}
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

      {/* Expanded — search box + filtered, scrollable list. */}
      {open && (
        <div className="rounded-lg border border-border/40 bg-card/40 p-1.5 space-y-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={ts.searchPlaceholder}
              className="w-full ps-9 pe-3 py-2 bg-card border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
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
  onEdit: () => void;
}

export const DeployTargetSummary: React.FC<CompactSummaryProps> = ({
  deployTarget,
  buildStrategy,
  serverName,
  showBuildStrategy = true,
  cloudResourceTier,
  hasServer = true,
  onEdit,
}) => {
  const { t } = useI18n();
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

  // Cloud-only chip on the right of the summary. Two shapes:
  //   - Static workloads (no Start command, files served from the edge)
  //     have no machine to size — show a neutral "Static" chip instead
  //     of a power tier. Otherwise "Low" / "Medium" / etc. would imply
  //     a runtime that doesn't exist.
  //   - Otherwise the picked resource tier with a Zap (power) icon.
  const tierChip =
    deployTarget === "cloud"
      ? !hasServer
        ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-info-bg text-[11px] font-medium text-info shrink-0">
            <Globe className="size-3" />
            {t.deploy.summary.static}
          </span>
        )
        : cloudResourceTier
          ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-warning-bg text-[11px] font-medium text-warning shrink-0">
              <Zap className="size-3" />
              <span>{tierLabels[cloudResourceTier] ?? cloudResourceTier}</span>
            </span>
          )
          : null
      : null;

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
      {tierChip}
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

// "Have we shown the first-deploy build hint yet?" - set on the first
// Continue. Once set, subsequent deploys get the full Build picker.
const buildHintFlag = createPersistedFlag("openship.build-hint-seen");

// ─── Main step ───────────────────────────────────────────────────────────────

interface DeployTargetStepProps {
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
// Placeholder runtime shapes for the Openship Cloud power picker. The
// numbers here are the UX surface only — the backend owns the
// authoritative cpu/mem/disk values per tier and translates them at
// provision time. Billing is credits-based (no $/mo shown here).
type CloudResourceTier = NonNullable<DeploymentConfig["cloudResourceTier"]>;

// Specs are technical values (kept verbatim); label + bestFor are looked up
// from the dictionary by `id` inside CloudPowerPicker.
const CLOUD_RESOURCE_TIERS: Array<{
    id: Exclude<CloudResourceTier, "custom">;
    cpu: string;
    ram: string;
    disk: string;
}> = [
    { id: "micro", cpu: "0.25 vCPU", ram: "256 MB", disk: "4 GB" },
    { id: "low", cpu: "0.5 vCPU", ram: "512 MB", disk: "8 GB" },
    { id: "medium", cpu: "1 vCPU", ram: "1 GB", disk: "16 GB" },
    { id: "high", cpu: "2 vCPU", ram: "2 GB", disk: "32 GB" },
];

const CUSTOM_DEFAULTS = { cpuCores: 1, memoryMb: 1024, diskMb: 16384 };

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

const DeployTargetStep: React.FC<DeployTargetStepProps> = ({ targets, onContinue, autoSkipAllowed = true }) => {
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
  // First-deploy-ever flag - read from localStorage on mount. When true,
  // we hide the Build picker, auto-match build to deploy, and show a small
  // hint card instead. Flipped off on the first successful Continue so the
  // full picker re-appears on subsequent deploys.
  const [isFirstBuildHint, setIsFirstBuildHint] = useState(false);
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

  // On mount: read first-deploy flag from localStorage. We treat the very
  // first deploy as "build hint shown" - once the user clicks Continue we
  // mark it seen, and from then on the full Build picker is back. Skipping
  // the picker on first run keeps the UI focused; the option remains
  // available in the post-continue summary and in Settings.
  useEffect(() => {
    setIsFirstBuildHint(!buildHintFlag.isSet());
  }, []);

  // First-deploy-only: preselect the build strategy until the user makes an
  // explicit pick in the Advanced disclosure (buildStrategyTouchedRef).
  // UNIFIED build: build on the same place you deploy — a SERVER target builds
  // on that server (no separate "This Machine" step), and cloud builds in the
  // cloud runtime. Only the bare "local" target builds locally (it IS the host,
  // so buildStrategy is inert there anyway). A server deploy that lacks a clone
  // credential still auto-downgrades to a local build at deploy time
  // (Sidebar.handleDeploy), so this never hard-fails a credential-less box.
  useEffect(() => {
    // Never override an explicit user pick — only preselect on the untouched
    // first-deploy default.
    if (!isFirstBuildHint || buildStrategyTouchedRef.current) return;
    const want: BuildStrategy = config.deployTarget === "local" ? "local" : "server";
    if (config.buildStrategy !== want) {
      updateConfig({ buildStrategy: want });
    }
  }, [isFirstBuildHint, config.deployTarget, config.buildStrategy, updateConfig]);

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
  const showCloneStrategy =
    config.deployTarget === "server" &&
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

  // Whether the credential-forwarding relay can run for this target. The relay
  // is desktop-only and needs a real SSH reverse tunnel — which every remote
  // server has (key, password, OR agent), and only a local/no-SSH target lacks.
  // So any server with a configured SSH auth method is relay-capable; the
  // backend re-checks the true capability (executor.reverseForward) + a local gh
  // before actually forwarding, and degrades to an api-host clone otherwise.
  const selectedServerAuth = servers.find((s) => s.id === config.serverId)?.sshAuthMethod ?? null;
  const relayCapable = selectedServerAuth != null;
  // Single source of truth for "forward the git credential for a server clone":
  // desktop + an SSH-reachable server. Both the default effect and the manual
  // clone-card pick read this, so they can never drift.
  const canForwardServerClone = isDesktop && relayCapable;

  // Default the clone location to "on the server" and, for a capable desktop
  // server clone, default forwarding ON — the secure + atomic path (clone on the
  // build host, nothing persisted). Only for a brand-new deploy, and only when
  // the choice is UNSET: never override an explicit user pick, so an opt-out
  // (unchecking → forwardGitCredentials=false) sticks.
  useEffect(() => {
    if (config.projectId) return;
    if (!showCloneStrategy) return;
    const clone: CloneStrategy = config.cloneStrategy ?? "server";
    const patch: { cloneStrategy?: CloneStrategy; forwardGitCredentials?: boolean } = {};
    if (config.cloneStrategy == null) patch.cloneStrategy = clone;
    if (config.forwardGitCredentials == null && clone === "server" && canForwardServerClone) {
      patch.forwardGitCredentials = true;
    }
    if (Object.keys(patch).length > 0) updateConfig(patch);
  }, [
    config.projectId,
    showCloneStrategy,
    config.cloneStrategy,
    config.forwardGitCredentials,
    canForwardServerClone,
    updateConfig,
  ]);

  // Advanced-panel summary line (build location). Clone location has its own
  // right-panel picker, so it isn't summarized here.
  const advancedSummary = showBuildStrategy
    ? interpolate(ts.build.advancedSummary, {
        action: config.options.hasBuild ? ts.build.actionBuild : ts.build.actionPrepare,
        location: visibleBuildOptions.find((o) => o.value === config.buildStrategy)?.label ?? "—",
      })
    : ts.build.options;

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
    // Persist the "build hint seen" flag too - auto-skipping past the
    // picker also means the user has effectively been through it once.
    buildHintFlag.set();
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

  const handleContinue = () => {
    // The only hard gate at this step: deploying TO Openship Cloud needs an
    // Openship Cloud connection. Anything else (free .${baseDomain} domains
    // on own-server / local, free domains in compose services, etc.) is a
    // downstream concern - the stack/domains screens after Continue prompt
    // for cloud at the exact moment it's actually needed. Interrupting here
    // is paternalistic and breaks the "I picked my own server, leave me
    // alone" signal the user just gave us.
    if (config.deployTarget === "cloud" && !hasCloudConnected) {
      if (!requireCloud(ts.requireCloudFeature)) {
        return;
      }
    }

    // Mark the build hint as seen - future deploys get the full Build picker.
    buildHintFlag.set();

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
  // Runtime-isolation (Sandbox/Direct) applies only to a self-hosted server APP —
  // docker/compose always run sandboxed, static has no long-running process.
  const showRuntimeIsolation =
    config.options.hasServer && config.projectType !== "docker" && !isServiceDeployment;
  const showRightPanel = showCloudPicker || showServerAdvanced;

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
  const header = showRightPanel ? (
    // Same track as the body grid (gap-0 on lg) so the third cell lines up
    // pixel-for-pixel with the advanced panel underneath it.
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
          showRightPanel
            ? "grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_1px_320px] gap-0 items-start"
            : ""
        }
      >
    <div className={`space-y-8 ${showRightPanel ? "lg:pe-6" : ""}`}>
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

      {/* Advanced (Sandbox/Direct, build location, clone, git-forward) renders
          as a compact panel in the RIGHT column for server deploys — see the
          right-panel block below. Continue lives in the unified header. */}

      {/* Single-column layout: save-default sits under the options (Continue is
          in the header). With a right panel, save-default moves into it. */}
      {!showRightPanel && saveDefaultCheckbox}
    </div>
    {showRightPanel && (
      <>
        {/* Vertical divider between the two columns. Right column = cloud
            power/resource picker OR the server "Advanced" disclosure — a
            compact panel beside the target choice instead of a wide expander
            under it. */}
        <div className="hidden lg:block w-px bg-border self-stretch" />
        <div key={config.deployTarget} className="lg:ps-6 animate-slide-in-right space-y-6">
          {/* Continue is in the unified header; the right column carries the
              save-default toggle then the Cloud/Advanced panel. */}
          {saveDefaultCheckbox}
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
                    <p className="truncate text-xs text-muted-foreground">{advancedSummary}</p>
                  </div>
                </div>
                {advancedOpen ? (
                  <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                )}
              </button>

              {advancedOpen && (
                <div className="border-t border-border/50 px-4 py-4 space-y-5">
                  {/* Runtime isolation — Sandbox (default) vs Direct. Server app only. */}
                  {showRuntimeIsolation && <ServerRuntimePicker />}

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
                      <div className="space-y-2">
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
                          />
                        ))}
                      </div>
                    </div>
                  )}

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
                      <div className="space-y-2">
                        {cloneOptions.map((opt) => (
                          <OptionCard
                            key={opt.value}
                            value={opt.value}
                            selected={cloneStrategy === opt.value}
                            onSelect={() =>
                              updateConfig({
                                cloneStrategy: opt.value,
                                // "Clone on the server" forwards the git identity
                                // (desktop + SSH-reachable server); "api-host" is
                                // the explicit opt-out (false → clone here +
                                // transfer). The backend re-checks the real relay
                                // capability + a local gh before forwarding.
                                forwardGitCredentials:
                                  opt.value === "server" && canForwardServerClone,
                              })
                            }
                            icon={opt.icon}
                            label={opt.label}
                            description={opt.description}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Git credential forwarding — Direct (bare) app, desktop-only. */}
                  {isDesktop && config.runtimeMode === "bare" && !isServiceDeployment && (
                    <label className="flex items-start gap-2.5 cursor-pointer select-none rounded-xl border border-border/50 bg-card/40 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={config.forwardGitCredentials === true}
                        onChange={(e) => updateConfig({ forwardGitCredentials: e.target.checked })}
                        className="mt-0.5 size-4 shrink-0 rounded border-border/60 bg-card text-primary focus:ring-2 focus:ring-primary/30 focus:ring-offset-0 cursor-pointer"
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                          <GitBranch className="size-3.5 text-muted-foreground" />
                          {ts.gitForwardLabel}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground leading-snug">
                          {ts.gitForwardDescPre}
                          <span className="font-mono text-foreground/80">gh</span>
                          {ts.gitForwardDescPost}
                        </span>
                      </span>
                    </label>
                  )}
                </div>
              )}
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
