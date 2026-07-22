"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  RefreshCw,
  Loader2,
  Database,
  Network,
  AlertTriangle,
  AlertCircle,
  Layers,
  Container,
  Check,
  X,
  ArrowRight,
  Trash2,
  CheckCircle2,
  Plus,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import {
  dockerMigrationApi,
  deployApi,
  getApiErrorMessage,
  type DiscoveredStack,
  type DiscoveredGroup,
  type DiscoveredService,
  type OpenshipProjectGroup,
  type MigrationRun,
  type MigrationStatus,
} from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { randomUUID } from "@/lib/random-uuid";
import { AppLogo } from "@/components/AppLogo";
import { DeploymentTerminal } from "@/components/import-project/DeploymentTerminal";

/** Platforms whose Docker/Compose apps this flow can adopt — shown as faint
 *  brand hints under the intro (decorative). Unknown marks fall back to a
 *  neutral glyph inside AppLogo. */
const MIGRATE_SOURCES = ["coolify", "dokku", "dokploy", "docker"] as const;

/** A service that builds from source with no registry image can't migrate in v1. */
const isBlocked = (s: DiscoveredService) => Boolean(s.build) && !s.image;

/** The dockerized edge proxy (80/443). Openship's OpenResty replaces it, so it's
 *  never imported — importing it would just replay the 80/443 conflict. */
const isProxy = (s: DiscoveredService) => Boolean(s.proxyKind);

/** Not importable as a workload: build-from-source, or the edge proxy. */
const isExcluded = (s: DiscoveredService) => isBlocked(s) || isProxy(s);

/** ":80/:443" label for a service's edge ports. */
const edgePortLabel = (s: DiscoveredService) => (s.edgePorts ?? []).map((p) => `:${p}`).join("/");

/** Unique selection key for a discovered service. Two different containers can
 *  share a `name` (e.g. a standalone `postgres` AND a compose `postgres`), so
 *  keying selection by name makes them toggle together. Use the real container
 *  id (unique per running container); fall back to name only if it's absent. */
const svcUid = (s: DiscoveredService) => s.containerId ?? s.name;

/** Stable key for a group — the compose project name, or the standalone sentinel. */
const STANDALONE = "__standalone__";
const groupKey = (g: DiscoveredGroup) => g.project ?? STANDALONE;

const RUN_PHASES: MigrationStatus[] = ["adopting", "moving_data", "deploying", "verifying"];

/**
 * One Openship project to create from the scan. A project maps to AT MOST one
 * compose (or a set of standalone containers) — you can't merge two composes.
 * `bound` is the group key its services belong to (null until the first pick).
 */
interface ImportProject {
  id: string;
  name: string;
  services: Set<string>;
  bound: string | null;
}

/** Same-server volume ownership per service: "reuse" (take over in place, the
 *  default) or "copy" (duplicate into a new Openship volume, keep the original). */
type VolumeStrategy = "reuse" | "copy";

interface MigrateItem {
  name: string;
  serviceNames: string[];
  /** serviceName → "copy" (only copy entries are sent; reuse is the default). */
  volumeStrategies: Record<string, VolumeStrategy>;
}

/** A service exposes a named volume worth a take-over/copy choice. */
const hasNamedVolume = (s: DiscoveredService) =>
  s.volumes.some((v) => v.type === "volume" && v.source);

/** Docker's built-in networks — always present, never migrated, so they're
 *  noise in a per-project import summary. */
const BUILTIN_NETWORKS = new Set(["host", "none", "bridge"]);

/**
 * Migrate existing Docker deployment(s) into Openship: pick a server → inspect →
 * organise the discovered stack into one or more PROJECTS (tabs) → migrate.
 * Each project reuses the existing named volumes in place. Multiple projects run
 * sequentially, each with its own cutover.
 */
export function ServerMigrationWizard({
  isOpen,
  onClose,
  serverId,
}: {
  isOpen: boolean;
  onClose: () => void;
  serverId?: string;
}) {
  const { t } = useI18n();
  const m = t.migration;
  const router = useRouter();

  const [selectedId, setSelectedId] = useState<string | null>(serverId ?? null);
  const [targetId, setTargetId] = useState<string | null>(serverId ?? null);
  const [serverName, setServerName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<string>("");
  const [stack, setStack] = useState<DiscoveredStack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [killOriginals, setKillOriginals] = useState(false);
  // "" = use the user's Settings default (send nothing); else per-run override.
  const [transferMode, setTransferMode] = useState<"" | "auto" | "stream" | "direct" | "rsync">("");

  // Projects (tabs) + the active one.
  const [projects, setProjects] = useState<ImportProject[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Per-service same-server volume ownership, keyed by svcUid. Default (absent) =
  // "reuse" (take over in place). A service belongs to exactly one project.
  const [volumeStrategy, setVolumeStrategy] = useState<Record<string, VolumeStrategy>>({});

  // Sequential multi-project migration state.
  const [queue, setQueue] = useState<MigrateItem[] | null>(null);
  const [queueIndex, setQueueIndex] = useState(0);
  const [completed, setCompleted] = useState<Array<{ name: string; projectId?: string | null }>>([]);
  const [starting, setStarting] = useState(false);
  const [migrationId, setMigrationId] = useState<string | null>(null);
  const [confirmToken, setConfirmToken] = useState<string | null>(null);
  const [run, setRun] = useState<MigrationRun | null>(null);
  // Per-service status peek (the failure rows). Full logs are shown by the
  // embedded DeploymentTerminal (its own build-session stream), not here.
  const [deploy, setDeploy] = useState<{
    services?: Array<{ name: string; status: string; error?: string }>;
  } | null>(null);
  const [cutoverBusy, setCutoverBusy] = useState(false);

  const reset = () => {
    setStack(null);
    setError(null);
    setProjects([]);
    setActiveId(null);
    setVolumeStrategy({});
    setScanning(false);
    setKillOriginals(false);
    setTransferMode("");
    setQueue(null);
    setQueueIndex(0);
    setCompleted([]);
    setStarting(false);
    setMigrationId(null);
    setConfirmToken(null);
    setRun(null);
    setCutoverBusy(false);
  };

  const close = () => {
    reset();
    if (!serverId) setSelectedId(null);
    onClose();
  };

  const pickServer = (s: ServerOption | null) => {
    setSelectedId(s?.id ?? null);
    setServerName(s?.name ?? null);
    reset();
    setTargetId(s?.id ?? null);
  };

  const handleScan = async () => {
    if (!selectedId) return;
    setScanning(true);
    setScanStatus("");
    setError(null);
    setStack(null);
    setProjects([]);
    try {
      // Stream the inspect (SSE): step progress + no fixed timeout, so a slow
      // SSH + docker inspect doesn't get aborted (the old plain POST hit the
      // 15s client default through the same-origin proxy).
      const scanned = await dockerMigrationApi.scanStream(selectedId, {
        onProgress: setScanStatus,
      });
      setStack(scanned);
      if (!scanned.adoptable) {
        setError(m.discover.nothing);
        return;
      }
      // Seed ONE project from the first group (compose preferred), pre-selecting
      // its migratable services. The user adds more project tabs for the rest.
      const first = scanned.groups.find((g) => g.services.some((s) => !isExcluded(s)));
      if (first) {
        const uids = first.services.filter((s) => !isExcluded(s)).map(svcUid);
        setProjects([
          {
            id: randomUUID(),
            name: first.project ?? serverName ?? "migrated-app",
            services: new Set(uids),
            bound: groupKey(first),
          },
        ]);
      }
    } catch (e) {
      setError(getApiErrorMessage(e, m.scanFailed));
    } finally {
      setScanning(false);
    }
  };

  // ── Project (tab) ops ──────────────────────────────────────────────────────
  const active = useMemo(
    () => projects.find((p) => p.id === activeId) ?? projects[0] ?? null,
    [projects, activeId],
  );

  // service name → the project id that already claimed it (exclusive assignment).
  const claimedBy = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) for (const s of p.services) map.set(s, p.id);
    return map;
  }, [projects]);

  const groupLabel = (key: string | null) =>
    key === null || key === STANDALONE ? m.discover.standaloneGroup : key;

  const nextProjectName = () => {
    const usedComposes = new Set(projects.map((p) => p.bound).filter(Boolean));
    const freeCompose = stack?.groups.find(
      (g) => g.project && !usedComposes.has(g.project),
    )?.project;
    if (freeCompose) return freeCompose;
    return `project-${projects.length + 1}`;
  };

  const addProject = () => {
    const p: ImportProject = { id: randomUUID(), name: nextProjectName(), services: new Set(), bound: null };
    setProjects((prev) => [...prev, p]);
    setActiveId(p.id);
  };

  const removeProject = (id: string) => {
    setProjects((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((p) => p.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
      return next;
    });
  };

  const renameProject = (id: string, name: string) =>
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));

  /** Can the active project accept a service from `key` group? Empty project →
   *  binds to any group; otherwise only its already-bound group. */
  const canBind = (key: string) => !active || active.services.size === 0 || active.bound === key;

  const toggleService = (svc: DiscoveredService, key: string) => {
    if (!active || isExcluded(svc)) return;
    const uid = svcUid(svc);
    const owner = claimedBy.get(uid);
    if (owner && owner !== active.id) return; // claimed by another project
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== active.id) return p;
        const services = new Set(p.services);
        if (services.has(uid)) {
          services.delete(uid);
        } else {
          if (!canBind(key)) return p; // one-compose-per-project guard
          services.add(uid);
        }
        return { ...p, services, bound: services.size ? (p.bound ?? key) : null };
      }),
    );
  };

  const toggleGroup = (group: DiscoveredGroup) => {
    if (!active) return;
    const key = groupKey(group);
    if (!canBind(key)) return;
    const uids = group.services
      .filter((s) => !isExcluded(s) && (claimedBy.get(svcUid(s)) ?? active.id) === active.id)
      .map(svcUid);
    if (uids.length === 0) return;
    const allOn = uids.every((u) => active.services.has(u));
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== active.id) return p;
        const services = new Set(p.services);
        for (const u of uids) {
          if (allOn) services.delete(u);
          else services.add(u);
        }
        return { ...p, services, bound: services.size ? (p.bound ?? key) : null };
      }),
    );
  };

  // ── Derived ──────────────────────────────────────────────────────────────
  const adoptable = Boolean(stack?.adoptable);
  // Openship projects on the server that this instance doesn't know → re-importable.
  const orphanedOpenship = useMemo(
    () => stack?.openshipProjects?.filter((p) => !p.knownHere) ?? [],
    [stack],
  );
  const hasReimport = orphanedOpenship.length > 0;
  const sameServer = selectedId === targetId;
  // Cross-server can't move a locally-built image (not in a registry) — the API
  // blocks it with the exact service names. Surface the caveat up front when a
  // built service exists and a different target is picked.
  const crossServerBuiltSoon = !sameServer && Boolean(stack?.services.some((s) => Boolean(s.build)));
  const migratable = projects.filter((p) => p.services.size > 0 && p.name.trim().length > 0);
  const canMigrate =
    Boolean(selectedId) && Boolean(targetId) && migratable.length > 0 && !starting && !queue;

  // ── Migrate (sequential, one project at a time) ────────────────────────────
  const startMigration = async (item: MigrateItem) => {
    if (!selectedId || !targetId) return;
    setStarting(true);
    setError(null);
    try {
      const res = await dockerMigrationApi.migrate({
        sourceServerId: selectedId,
        targetServerId: targetId,
        serviceNames: item.serviceNames,
        projectName: item.name,
        killOriginals,
        volumeStrategies: Object.keys(item.volumeStrategies).length
          ? item.volumeStrategies
          : undefined,
        transferMode: transferMode || undefined,
      });
      setMigrationId(res.migrationId);
      setConfirmToken(res.confirmationToken);
      setRun({
        id: res.migrationId,
        status: "queued",
        mode: sameServer ? "same_server" : "cross_server",
      });
    } catch (e) {
      setError(getApiErrorMessage(e, m.adoptFailed));
    } finally {
      setStarting(false);
    }
  };

  const handleMigrate = () => {
    if (!canMigrate) return;
    // Selection is keyed by uid; the migration API wants the actual container
    // names — resolve uid → name from the scanned stack. Copy choices apply only
    // to same-server migrations (cross-server always copies A→B and keeps A).
    const items = migratable.map((p) => {
      const picked = (stack?.services ?? []).filter((s) => p.services.has(svcUid(s)));
      const volumeStrategies: Record<string, VolumeStrategy> = {};
      if (sameServer) {
        for (const s of picked) {
          if (volumeStrategy[svcUid(s)] === "copy") volumeStrategies[s.name] = "copy";
        }
      }
      return { name: p.name.trim(), serviceNames: picked.map((s) => s.name), volumeStrategies };
    });
    setQueue(items);
    setQueueIndex(0);
    setCompleted([]);
    void startMigration(items[0]);
  };

  const handleCutover = async (kill: boolean) => {
    if (!migrationId || !confirmToken) return;
    setCutoverBusy(true);
    setError(null);
    try {
      await dockerMigrationApi.confirmCutover(migrationId, confirmToken, kill);
      const res = await dockerMigrationApi.getMigration(migrationId);
      setRun(res.run);
    } catch (e) {
      setError(getApiErrorMessage(e, m.adoptFailed));
    } finally {
      setCutoverBusy(false);
    }
  };

  // Advance the queue when the current project's migration succeeds.
  useEffect(() => {
    if (!queue || run?.status !== "succeeded") return;
    setCompleted((prev) => [...prev, { name: queue[queueIndex]?.name ?? "", projectId: run.projectId }]);
    const nextIndex = queueIndex + 1;
    if (nextIndex < queue.length) {
      setQueueIndex(nextIndex);
      setMigrationId(null);
      setConfirmToken(null);
      setRun(null);
      void startMigration(queue[nextIndex]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status]);

  const allDone = Boolean(queue) && completed.length >= (queue?.length ?? 0);

  const lastProjectId = () => completed[completed.length - 1]?.projectId ?? run?.projectId;

  const openProject = () => {
    const pid = lastProjectId();
    close();
    if (pid) router.push(`/projects/${pid}`);
  };

  // The natural next step: assign a domain per exposed service (the migrated
  // apps are pre-exposed, no domain yet) on the project's Domains tab. Adding a
  // domain + redeploying is what ensures OpenResty (and reclaims 80/443 from the
  // old proxy via the takeover modal).
  const openDomains = () => {
    const pid = lastProjectId();
    close();
    if (pid) router.push(`/projects/${pid}/domains`);
  };

  // On a deploy/verify failure the run row only carries a one-line reason. The
  // real stepper, full logs, and per-service failure detail live on the target
  // deployment's build screen — deep-link to it so "just failed" isn't a
  // dead-end. (Only meaningful once the deploy started, i.e. deploymentId set.)
  const openDeployLogs = () => {
    const depId = run?.deploymentId;
    if (!depId) return;
    close();
    router.push(`/build/${depId}`);
  };

  // Poll the current run while a migration is in flight; stop once terminal.
  useEffect(() => {
    if (!migrationId) return;
    if (run && ["succeeded", "failed", "rolled_back"].includes(run.status)) return;
    let live = true;
    const tick = async () => {
      try {
        const res = await dockerMigrationApi.getMigration(migrationId);
        if (live) setRun(res.run);
      } catch {
        /* transient — keep polling */
      }
    };
    const iv = setInterval(tick, 2500);
    void tick();
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [migrationId, run?.status]);

  // Pull the target deploy's logs + per-service status while it's deploying/
  // verifying (live) and once it fails — so the wizard shows the actual reason
  // and log tail inline instead of only a one-line "partial_failure".
  useEffect(() => {
    const depId = run?.deploymentId;
    const live = run?.status === "deploying" || run?.status === "verifying";
    const failedNow = run?.status === "failed" || run?.status === "rolled_back";
    if (!depId || (!live && !failedNow)) {
      setDeploy(null);
      return;
    }
    let on = true;
    const tick = async () => {
      try {
        const st = await deployApi.getBuildStatus(depId);
        if (!on) return;
        setDeploy({
          services: Array.isArray(st?.serviceStatuses)
            ? st.serviceStatuses.map((s: Record<string, unknown>) => ({
                name: String(s.serviceName ?? s.serviceId ?? "service"),
                status: String(s.status ?? ""),
                error: (s.errorMessage as string) || (s.error as string) || undefined,
              }))
            : undefined,
        });
      } catch {
        /* transient */
      }
    };
    void tick();
    // Live phases keep polling; a terminal failure only needs one fetch.
    const iv = live ? setInterval(tick, 2500) : null;
    return () => {
      on = false;
      if (iv) clearInterval(iv);
    };
  }, [run?.deploymentId, run?.status]);

  const inProgress = Boolean(queue);
  const failed = run?.status === "failed" || run?.status === "rolled_back";
  // Only go near-full-screen once there are RESULTS to show (an adoptable stack
  // or an in-flight migration). The empty prompt, the loading state, and a
  // "nothing found" result all stay a compact, content-sized dialog.
  const expanded = adoptable || inProgress;

  // Wide layout for the scan/select table AND for the deploy phase — once a
  // target deployment exists (deploying/verifying/failed) we mount the native
  // terminal, which needs the full-width shell. Earlier progress phases
  // (adopting/moving_data) have only a short step list → stay compact.
  const wide = expanded && (!inProgress || Boolean(run?.deploymentId));

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      width={wide ? "1600px" : "560px"}
      maxWidth="95vw"
      maxHeight={wide ? "95vh" : "86vh"}
      overflow="hidden"
      showCloseButton={false}
    >
      <div className={`flex flex-col ${wide ? "h-[95vh]" : "max-h-[86vh]"}`}>
        {/* Header — compact single-line intro to keep it short. */}
        <div className="shrink-0 flex items-center justify-between gap-4 px-6 py-4 border-b border-border/60 bg-muted/[0.18]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="size-9 rounded-xl bg-primary/10 ring-1 ring-inset ring-primary/20 flex items-center justify-center shrink-0">
              <Container className="size-[18px] text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground leading-tight">{m.wizard.title}</h2>
              <p className="text-xs text-muted-foreground truncate max-w-3xl">{m.wizard.intro}</p>
            </div>
          </div>
          <button
            onClick={close}
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          >
            <X className="size-5" />
          </button>
        </div>

        {inProgress ? (
          /* ── Migration progress (queue) ── */
          <>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <MigrationProgress
                run={run}
                error={error}
                queueName={queue?.[queueIndex]?.name ?? ""}
                queueIndex={queueIndex}
                queueTotal={queue?.length ?? 1}
                completed={completed}
                deployServices={deploy?.services}
              />
            </div>
            <div className="shrink-0 flex items-center justify-between gap-4 px-6 py-4 border-t border-border/60">
              {run?.status === "awaiting_cutover" ? (
                <>
                  <span className="text-xs text-muted-foreground flex-1 min-w-0">{m.cutover.warning}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleCutover(false)}
                      disabled={cutoverBusy}
                      className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                    >
                      {m.cutover.keep}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCutover(true)}
                      disabled={cutoverBusy}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition-colors disabled:opacity-40"
                    >
                      {cutoverBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      {m.cutover.stopRemove}
                    </button>
                  </div>
                </>
              ) : allDone ? (
                <>
                  <span />
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={close}
                      className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                    >
                      {m.wizard.close}
                    </button>
                    <button
                      type="button"
                      onClick={openProject}
                      className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                    >
                      {m.run.openProject}
                    </button>
                    <button
                      type="button"
                      onClick={openDomains}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
                    >
                      <ArrowRight className="size-4" />
                      {m.run.addDomains}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span />
                  <div className="flex items-center gap-2 shrink-0">
                    {failed && run?.deploymentId && (
                      <button
                        type="button"
                        onClick={openDeployLogs}
                        className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                      >
                        {m.run.viewDeployLogs}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={close}
                      className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                    >
                      {failed ? m.wizard.close : m.wizard.cancel}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          /* ── Selection (scan + tabs + two columns) ── */
          <>
            {/* Server picker (only when the modal isn't pinned to a server).
                Inspect Docker + Re-scan both live in the footer. */}
            {!serverId && (
              <div className="shrink-0 px-6 pt-4">
                <ServerSelector value={selectedId} onSelect={pickServer} compact />
              </div>
            )}

            {/* Project tabs */}
            {adoptable && stack && projects.length > 0 && (
              <div className="shrink-0 flex items-center gap-1.5 px-6 pt-4 flex-wrap">
                {projects.map((p) => {
                  const on = p.id === active?.id;
                  return (
                    <div
                      key={p.id}
                      className={`group inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                        on
                          ? "border-primary/50 bg-primary/10 text-foreground"
                          : "border-border/60 text-muted-foreground hover:bg-muted/40"
                      }`}
                      onClick={() => setActiveId(p.id)}
                    >
                      <Layers className={`size-3.5 ${on ? "text-primary" : ""}`} />
                      <span className="font-medium truncate max-w-[160px]">
                        {p.name || m.wizard.projectName}
                      </span>
                      <span className="text-xs text-muted-foreground">· {p.services.size}</span>
                      {projects.length > 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeProject(p.id);
                          }}
                          className="rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          aria-label={m.wizard.removeProject}
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={addProject}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                >
                  <Plus className="size-3.5" />
                  {m.wizard.addProject}
                </button>
              </div>
            )}

            {/* Body */}
            <div className="flex-1 min-h-0 overflow-hidden px-6 py-4">
              {/* Idle + loading keep the illustration (loading just pulses it). */}
              {!stack && !error && <EmptyHint scanning={scanning} status={scanStatus} />}

              {/* Scanned but nothing adoptable AND nothing to re-import → compact
                  "nothing found" (not a giant empty modal). */}
              {stack && !adoptable && !hasReimport && <NoResults message={m.discover.nothing} />}

              {/* Only Openship projects to re-import (no generic candidates): show
                  the re-import section on its own. */}
              {stack && !adoptable && hasReimport && (
                <div className="h-full min-h-0 overflow-y-auto pr-1">
                  <OpenshipReimportSection
                    serverId={selectedId ?? ""}
                    orphaned={orphanedOpenship}
                    alreadyManaged={stack.alreadyManaged}
                    onOpen={(pid) => router.push(`/projects/${pid}`)}
                  />
                </div>
              )}

              {adoptable && stack && active && (
                <div className="flex gap-5 h-full min-h-0">
                  {/* LEFT: discovered groups */}
                  <div className="flex-[3] min-w-0 overflow-y-auto pr-1 space-y-4">
                    {hasReimport && (
                      <OpenshipReimportSection
                        serverId={selectedId ?? ""}
                        orphaned={orphanedOpenship}
                        alreadyManaged={stack.alreadyManaged}
                        onOpen={(pid) => router.push(`/projects/${pid}`)}
                      />
                    )}
                    {stack.groups.map((group) => (
                      <ServiceGroup
                        key={groupKey(group)}
                        group={group}
                        activeProject={active}
                        claimedBy={claimedBy}
                        projectsById={projects}
                        onToggle={(svc) => toggleService(svc, groupKey(group))}
                        onToggleGroup={() => toggleGroup(group)}
                        groupLabel={groupLabel}
                      />
                    ))}
                  </div>
                  {/* RIGHT: active project summary */}
                  <div className="flex-[2] min-w-0 overflow-y-auto border-s border-border/50 ps-5">
                    <ProjectSummary
                      project={active}
                      stack={stack}
                      onRename={(name) => renameProject(active.id, name)}
                      sameServer={sameServer}
                      volumeStrategy={volumeStrategy}
                      onSetStrategy={(uid, strat) =>
                        setVolumeStrategy((prev) => ({ ...prev, [uid]: strat }))
                      }
                    />
                  </div>
                </div>
              )}

              {/* Scan failed (no stack) → same compact "nothing found" frame. */}
              {error && !stack && <NoResults message={error} isError />}
            </div>

            {/* Footer: target + cutover + migrate */}
            <div className="shrink-0 flex items-center justify-between gap-4 px-6 py-4 border-t border-border/60">
              {adoptable && stack ? (
                <>
                  <div className="flex items-center gap-3 flex-1 min-w-0 flex-wrap">
                    <div className="flex items-center gap-2 shrink-0">
                      <ArrowRight className="size-4 text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground">{m.wizard.targetLabel}</span>
                    </div>
                    <div className="w-56 min-w-0">
                      <ServerSelector value={targetId} onSelect={(s) => setTargetId(s?.id ?? null)} compact dropUp />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={killOriginals}
                        onChange={(e) => setKillOriginals(e.target.checked)}
                        className="size-4 rounded border-border"
                      />
                      {m.wizard.killOriginals}
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {m.wizard.transfer.label}
                      <select
                        value={transferMode}
                        onChange={(e) => setTransferMode(e.target.value as typeof transferMode)}
                        className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
                      >
                        <option value="">{m.wizard.transfer.default}</option>
                        <option value="auto">{m.wizard.transfer.auto}</option>
                        <option value="stream">{m.wizard.transfer.stream}</option>
                        <option value="direct">{m.wizard.transfer.direct}</option>
                        <option value="rsync">{m.wizard.transfer.rsync}</option>
                      </select>
                    </label>
                    <span
                      className={`text-xs ${sameServer ? "text-muted-foreground" : "text-warning"}`}
                    >
                      {sameServer ? m.wizard.sameServer : m.run.downtimeNote}
                    </span>
                    {crossServerBuiltSoon && (
                      <span className="text-xs text-warning/90 w-full">{m.wizard.crossServerBuiltSoon}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={handleScan}
                      disabled={!selectedId || scanning}
                      title={m.wizard.rescan}
                      aria-label={m.wizard.rescan}
                      className="p-2.5 rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {scanning ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={close}
                      className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                    >
                      {m.wizard.cancel}
                    </button>
                    <button
                      type="button"
                      onClick={handleMigrate}
                      disabled={!canMigrate}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {starting ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                      {migratable.length > 1
                        ? interpolate(m.wizard.migrateN, { n: String(migratable.length) })
                        : m.wizard.migrate}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span />
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={close}
                      className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                    >
                      {m.wizard.cancel}
                    </button>
                    <button
                      type="button"
                      onClick={handleScan}
                      disabled={!selectedId || scanning}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {scanning ? <Loader2 className="size-4 animate-spin" /> : stack ? <RefreshCw className="size-4" /> : <Search className="size-4" />}
                      {scanning ? m.wizard.scanning : stack ? m.wizard.rescan : m.wizard.scan}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function EmptyHint({ scanning, status }: { scanning?: boolean; status?: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 gap-4">
      {/* Themed illustration — a container stack being inspected under a lens
          (read-only "adopt"). Kept during the scan (pulses to signal loading)
          so the body never goes blank. */}
      <div className={`relative h-36 w-52 ${scanning ? "animate-pulse" : ""}`}>
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 220 150" fill="none">
          {/* ground */}
          <line x1="34" y1="112" x2="150" y2="112" stroke="var(--th-bd-subtle)" strokeWidth="1" />

          {/* back container */}
          <rect x="44" y="74" width="52" height="38" rx="4" fill="var(--th-sf-03)" stroke="var(--th-bd-default)" strokeWidth="1" />
          <line x1="60" y1="74" x2="60" y2="112" stroke="var(--th-bd-subtle)" strokeWidth="1" />
          <line x1="78" y1="74" x2="78" y2="112" stroke="var(--th-bd-subtle)" strokeWidth="1" />

          {/* front container */}
          <rect x="82" y="84" width="56" height="28" rx="4" fill="var(--th-sf-05)" stroke="var(--th-bd-default)" strokeWidth="1" />
          <line x1="100" y1="84" x2="100" y2="112" stroke="var(--th-bd-subtle)" strokeWidth="1" />
          <line x1="120" y1="84" x2="120" y2="112" stroke="var(--th-bd-subtle)" strokeWidth="1" />

          {/* small top container + activity lights */}
          <rect x="58" y="56" width="34" height="18" rx="3" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
          <circle cx="66" cy="65" r="2" fill="#22c55e" fillOpacity="0.7" />
          <circle cx="74" cy="65" r="2" fill="#eab308" fillOpacity="0.5" />
          <circle cx="82" cy="65" r="2" fill="var(--th-on-12)" />

          {/* magnifier inspecting a container */}
          <circle cx="150" cy="62" r="26" fill="var(--th-card-bg)" stroke="var(--th-bd-strong)" strokeWidth="2" />
          <rect x="139" y="55" width="22" height="15" rx="2" fill="var(--th-sf-06)" stroke="var(--th-bd-default)" strokeWidth="1" />
          <line x1="146" y1="55" x2="146" y2="70" stroke="var(--th-bd-subtle)" strokeWidth="1" />
          <line x1="154" y1="55" x2="154" y2="70" stroke="var(--th-bd-subtle)" strokeWidth="1" />
          <line x1="169" y1="81" x2="186" y2="98" stroke="var(--th-bd-strong)" strokeWidth="4" strokeLinecap="round" />

          {/* decorative dots + sparkles */}
          <circle cx="24" cy="46" r="3.5" fill="var(--th-on-10)" />
          <circle cx="30" cy="126" r="5" fill="var(--th-on-08)" />
          <circle cx="200" cy="40" r="3" fill="var(--th-on-12)" />
          <circle cx="196" cy="118" r="4.5" fill="var(--th-on-06)" />
          <path d="M14 82l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
          <path d="M202 76l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />
        </svg>
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">
        {scanning ? (status || t.migration.wizard.scanning) : t.migration.wizard.intro}
      </p>
      {!scanning && (
        <div
          className="mt-1 flex items-center gap-4 opacity-35 grayscale transition-opacity"
          aria-hidden
        >
          {MIGRATE_SOURCES.map((slug) => (
            <AppLogo key={slug} slug={slug} className="size-5" />
          ))}
        </div>
      )}
    </div>
  );
}

/** Compact "nothing found" / scan-failed state — same footprint as the idle
 *  prompt (never expands the modal), just a different illustration + message. */
function NoResults({ message, isError }: { message: string; isError?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 gap-4">
      <div className="relative h-32 w-48">
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 200 130" fill="none">
          {/* empty dashed container — nothing inside */}
          <line x1="44" y1="98" x2="132" y2="98" stroke="var(--th-bd-subtle)" strokeWidth="1" />
          <rect x="52" y="54" width="70" height="44" rx="6" fill="var(--th-sf-02)" stroke="var(--th-bd-default)" strokeWidth="1.5" strokeDasharray="5 5" />
          {/* magnifier finding nothing (a dash in the lens) */}
          <circle cx="132" cy="52" r="24" fill="var(--th-card-bg)" stroke="var(--th-bd-strong)" strokeWidth="2" />
          <line x1="123" y1="52" x2="141" y2="52" stroke="var(--th-on-30)" strokeWidth="2.5" strokeLinecap="round" />
          <line x1="150" y1="70" x2="166" y2="86" stroke="var(--th-bd-strong)" strokeWidth="4" strokeLinecap="round" />
          {/* decorative dots + sparkle */}
          <circle cx="26" cy="40" r="3" fill="var(--th-on-10)" />
          <circle cx="30" cy="110" r="4.5" fill="var(--th-on-08)" />
          <circle cx="182" cy="106" r="3.5" fill="var(--th-on-10)" />
          <path d="M18 74l1.6-3.2 1.6 3.2-3.2-1.6 3.2 0-3.2 1.6z" fill="var(--th-on-14)" />
        </svg>
      </div>
      <p className={`max-w-sm text-sm ${isError ? "text-destructive/90" : "text-muted-foreground"}`}>{message}</p>
    </div>
  );
}

/**
 * Openship projects recovered from the server (matched by the `openship.project`
 * label + the on-server manifest) that this instance doesn't know — DB reset
 * (DR) or a server from another instance. Re-import rebuilds the project records
 * PRESERVING the original id so the running containers re-attach; it's records
 * only (no move/redeploy), so a "redeploy to finalize" note follows.
 */
function OpenshipReimportSection({
  serverId,
  orphaned,
  alreadyManaged,
  onOpen,
}: {
  serverId: string;
  orphaned: OpenshipProjectGroup[];
  alreadyManaged: number;
  onOpen: (projectId: string) => void;
}) {
  const { t } = useI18n();
  const m = t.migration.reimport;
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const reimport = async (p: OpenshipProjectGroup) => {
    setBusy(p.projectId);
    setErrors((e) => ({ ...e, [p.projectId]: "" }));
    try {
      const res = await dockerMigrationApi.reimport({
        serverId,
        projectId: p.projectId,
        projectName: (names[p.projectId] ?? p.suggestedName).trim() || undefined,
      });
      setDone((d) => ({ ...d, [p.projectId]: res.projectId }));
    } catch (err) {
      setErrors((e) => ({ ...e, [p.projectId]: getApiErrorMessage(err, m.failed) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-info/30 bg-info/[0.06] p-4">
      <div className="flex items-center gap-2">
        <AppLogo className="size-4" />
        <h3 className="text-sm font-semibold text-foreground">{m.title}</h3>
        <span className="rounded-md bg-info/15 px-1.5 py-0.5 text-[11px] font-medium text-info">
          {orphaned.length}
        </span>
      </div>
      <p className="text-[13px] text-muted-foreground">{m.intro}</p>

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2 items-stretch">
        {orphaned.map((p) => {
          const doneId = done[p.projectId];
          const err = errors[p.projectId];
          return (
            <div
              key={p.projectId}
              className="flex h-full flex-col gap-2 rounded-lg border border-border/60 bg-card/60 p-3"
            >
              {doneId ? (
                <div className="flex h-full flex-col justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-sm text-success">
                    <CheckCircle2 className="size-4 shrink-0" />
                    <span className="font-medium">{m.reimported}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpen(doneId)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
                  >
                    {m.openProject}
                    <ArrowRight className="size-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <input
                    value={names[p.projectId] ?? p.suggestedName}
                    onChange={(e) => setNames((n) => ({ ...n, [p.projectId]: e.target.value }))}
                    className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-info"
                    placeholder={p.suggestedName}
                  />
                  <div className="text-xs text-muted-foreground">
                    {interpolate(m.services, { n: String(p.services.length) })}
                    {p.domains && p.domains.length > 0 ? ` · ${p.domains.join(", ")}` : ""}
                  </div>
                  {err && <p className="text-xs text-danger">{err}</p>}
                  <button
                    type="button"
                    disabled={busy === p.projectId || !serverId}
                    onClick={() => reimport(p)}
                    className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg border border-info/50 bg-info/10 px-3 py-1.5 text-sm font-medium text-info hover:bg-info/20 transition-colors disabled:opacity-50"
                  >
                    {busy === p.projectId ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        {m.working}
                      </>
                    ) : (
                      m.action
                    )}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {alreadyManaged > 0 && (
        <p className="text-xs text-muted-foreground">
          {interpolate(m.alreadyManaged, { n: String(alreadyManaged) })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{m.finalizeNote}</p>
    </section>
  );
}

function ServiceGroup({
  group,
  activeProject,
  claimedBy,
  projectsById,
  onToggle,
  onToggleGroup,
  groupLabel,
}: {
  group: DiscoveredGroup;
  activeProject: ImportProject;
  claimedBy: Map<string, string>;
  projectsById: ImportProject[];
  onToggle: (svc: DiscoveredService) => void;
  onToggleGroup: () => void;
  groupLabel: (key: string | null) => string;
}) {
  const { t } = useI18n();
  const m = t.migration.discover;
  const isCompose = group.project !== null;
  const key = group.project ?? "__standalone__";

  // The active project can bind to this group iff empty or already bound to it.
  const bindable = activeProject.services.size === 0 || activeProject.bound === key;
  const selectable = group.services.filter(
    (s) => !isExcluded(s) && (claimedBy.get(svcUid(s)) ?? activeProject.id) === activeProject.id,
  );
  const allOn = selectable.length > 0 && selectable.every((s) => activeProject.services.has(svcUid(s)));

  const nameOf = (id: string) => projectsById.find((p) => p.id === id)?.name || "";

  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-center gap-2 min-w-0">
          {isCompose ? (
            <Layers className="size-4 text-muted-foreground shrink-0" />
          ) : (
            <Container className="size-4 text-muted-foreground shrink-0" />
          )}
          <span className="text-sm font-semibold text-foreground truncate">
            {isCompose ? group.project : m.standaloneGroup}
          </span>
          {isCompose && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded-md bg-muted/70 text-muted-foreground shrink-0">
              {m.composeGroup}
            </span>
          )}
          <span className="text-[13px] text-muted-foreground shrink-0">· {group.services.length}</span>
        </div>
        {bindable && selectable.length > 0 && (
          <button
            type="button"
            onClick={onToggleGroup}
            className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <span
              className={`inline-flex items-center justify-center size-4 rounded border transition-colors ${
                allOn ? "bg-primary border-primary text-primary-foreground" : "border-border"
              }`}
            >
              {allOn && <Check className="size-3" />}
            </span>
            {m.selectAll}
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2 items-stretch">
        {group.services.map((s) => {
          const owner = claimedBy.get(svcUid(s));
          const claimedElsewhere = owner && owner !== activeProject.id;
          const blockedByBind = !bindable && !activeProject.services.has(svcUid(s));
          return (
            <ServiceRow
              key={svcUid(s)}
              service={s}
              checked={activeProject.services.has(svcUid(s))}
              claimedIn={claimedElsewhere ? nameOf(owner!) : null}
              bindHint={blockedByBind ? interpolate(m.otherComposeHint, { group: groupLabel(key) }) : null}
              onToggle={() => onToggle(s)}
            />
          );
        })}
      </div>
    </section>
  );
}

function ServiceRow({
  service,
  checked,
  claimedIn,
  bindHint,
  onToggle,
}: {
  service: DiscoveredService;
  checked: boolean;
  claimedIn: string | null;
  bindHint: string | null;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const m = t.migration.discover;
  const blocked = isBlocked(service);
  const proxy = isProxy(service);
  const disabled = blocked || proxy || Boolean(claimedIn) || Boolean(bindHint);
  const envCount = Object.keys(service.env).length;
  const source = service.build ? `${m.build}: ${service.dockerfile ?? service.build}` : service.image;

  return (
    <label
      className={`group flex h-full items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
        disabled
          ? "cursor-not-allowed border-border/50 opacity-55"
          : checked
            ? "cursor-pointer border-border/60 bg-primary/[0.04]"
            : "cursor-pointer border-border/50 hover:bg-muted/20"
      }`}
    >
      <span
        className={`mt-0.5 size-[18px] rounded-md border flex items-center justify-center shrink-0 transition-colors ${
          disabled
            ? "border-border bg-muted"
            : checked
              ? "bg-primary border-primary text-primary-foreground"
              : "border-border bg-transparent group-hover:border-foreground/40"
        }`}
      >
        {!disabled && checked && <Check className="size-3" />}
      </span>
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} className="sr-only" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground truncate">{service.name}</span>
          {service.ports.map((p, i) => (
            <span
              key={`${p}-${i}`}
              className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
            >
              {p}
            </span>
          ))}
          {claimedIn && (
            <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {interpolate(m.claimedIn, { project: claimedIn })}
            </span>
          )}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted-foreground">
          {source && <span className="font-mono max-w-full truncate text-muted-foreground/90">{source}</span>}
          {service.dependsOn.length > 0 && (
            <span>· {m.dependsOn} {service.dependsOn.join(", ")}</span>
          )}
          {service.volumes.length > 0 && (
            <span>· {interpolate(m.nVolumes, { n: String(service.volumes.length) })}</span>
          )}
          {envCount > 0 && <span>· {interpolate(m.nEnv, { n: String(envCount) })}</span>}
        </div>

        {blocked && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-warning">
            <AlertTriangle className="size-3.5 shrink-0" />
            {m.buildBlocked}
          </p>
        )}
        {!blocked && proxy && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-warning">
            <AlertTriangle className="size-3.5 shrink-0" />
            {interpolate(m.proxyExcluded, { ports: edgePortLabel(service) })}
          </p>
        )}
        {!blocked && !proxy && (service.edgePorts?.length ?? 0) > 0 && (
          <p className="mt-1 text-xs text-muted-foreground/80">
            {interpolate(m.edgePortReserved, { ports: edgePortLabel(service) })}
          </p>
        )}
        {!blocked && !proxy && bindHint && (
          <p className="mt-1 text-xs text-muted-foreground/80">{bindHint}</p>
        )}
      </div>

      {/* Quiet status — no loud filled pill; running stays muted, only the
          notable "stopped" state takes the on-brand warning tint. */}
      <span
        className={`mt-0.5 shrink-0 text-[11px] font-medium uppercase tracking-wide ${
          service.running ? "text-muted-foreground/70" : "text-warning"
        }`}
      >
        {service.running ? m.running : m.stopped}
      </span>
    </label>
  );
}

/** Right column — the active project's import summary. */
function ProjectSummary({
  project,
  stack,
  onRename,
  sameServer,
  volumeStrategy,
  onSetStrategy,
}: {
  project: ImportProject;
  stack: DiscoveredStack;
  onRename: (name: string) => void;
  /** Same-server migration reuses volumes in place — the only case a per-service
   *  take-over/copy choice is meaningful. Cross-server always copies. */
  sameServer: boolean;
  volumeStrategy: Record<string, VolumeStrategy>;
  onSetStrategy: (uid: string, strat: VolumeStrategy) => void;
}) {
  const { t } = useI18n();
  const m = t.migration.discover;
  const w = t.migration.wizard;

  const picked = useMemo(
    () => stack.services.filter((s) => project.services.has(svcUid(s))),
    [stack.services, project.services],
  );
  const ports = picked.flatMap((s) => s.ports);
  const volumes = Array.from(
    new Set(picked.flatMap((s) => s.volumes.filter((v) => v.type === "volume" && v.source).map((v) => v.source!))),
  );
  const envCount = picked.reduce((n, s) => n + Object.keys(s.env).length, 0);
  const warnings = Array.from(new Set(picked.flatMap((s) => s.warnings)));
  // Networks actually attached to the selected services — scoped like every
  // other stat here. Docker's built-in networks (host/none/bridge) are never
  // migrated, and another compose's networks aren't part of this project, so
  // both fall away naturally once we key off the picked services.
  const usedNetworks = Array.from(new Set(picked.flatMap((s) => s.networks)))
    .filter((n) => !BUILTIN_NETWORKS.has(n))
    .sort();
  // Services carrying a named volume — the ones a same-server take-over/copy
  // choice applies to. Strategy is keyed per service (svcUid), matching how
  // handleMigrate reads it back.
  const volServices = picked.filter(hasNamedVolume);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-[13px] font-medium text-muted-foreground">{w.projectName}</label>
        <input
          value={project.name}
          onChange={(e) => onRename(e.target.value)}
          placeholder={w.projectNamePlaceholder}
          className="w-full px-3.5 py-2.5 rounded-xl bg-card border border-border text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
        />
      </div>

      <div className="rounded-xl border border-border/50 p-4 space-y-3">
        <p className="text-sm font-semibold text-foreground">
          {interpolate(m.selectedCount, { n: String(picked.length), total: String(stack.services.length) })}
        </p>
        {picked.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {picked.map((s) => (
              <span
                key={svcUid(s)}
                className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs font-medium text-foreground"
              >
                {s.name}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">{m.emptyProject}</p>
        )}

        {/* Clean divided stat strip — reads as one cohesive figure, not loose text. */}
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border/50 bg-border/40">
          {[
            { n: ports.length, label: m.ports },
            { n: volumes.length, label: m.volumes },
            { n: envCount, label: m.env },
          ].map((stat) => (
            <div key={stat.label} className="bg-card px-3 py-2 text-center">
              <p className="text-sm font-semibold text-foreground">{stat.n}</p>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      {volServices.length > 0 && (
        <section className="space-y-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Database className="size-4 text-muted-foreground" /> {m.volumesTitle}
          </h4>
          <div className="space-y-2">
            {volServices.map((s) => {
              const names = s.volumes
                .filter((v) => v.type === "volume" && v.source)
                .map((v) => v.source!);
              const strat = volumeStrategy[svcUid(s)] ?? "reuse";
              return (
                <div
                  key={svcUid(s)}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">{s.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {names.join(", ")}
                    </p>
                  </div>
                  {sameServer ? (
                    <div className="flex shrink-0 rounded-lg border border-border/60 p-0.5 text-[11px] font-medium">
                      {(["reuse", "copy"] as const).map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => onSetStrategy(svcUid(s), opt)}
                          className={`rounded-md px-2.5 py-1 transition-colors ${
                            strat === opt
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {opt === "reuse" ? m.volumeReuse : m.volumeCopy}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {m.volumeCopy}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {sameServer && (
            <p className="text-[11px] leading-relaxed text-muted-foreground/80">
              {m.volumeCopyHint}
            </p>
          )}
        </section>
      )}

      {warnings.length > 0 && (
        <section className="rounded-xl border border-warning-border bg-warning-bg p-4 space-y-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-warning">
            <AlertTriangle className="size-4" /> {m.warningsTitle}
          </h4>
          <ul className="list-disc ps-5 space-y-1 text-xs text-foreground/90">
            {warnings.map((warn, i) => (
              <li key={i}>{warn}</li>
            ))}
          </ul>
        </section>
      )}

      {usedNetworks.length > 0 && (
        <section className="space-y-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Network className="size-4 text-muted-foreground" /> {m.networksTitle}
          </h4>
          <div className="flex flex-wrap gap-2">
            {usedNetworks.map((n) => (
              <span
                key={n}
                className="font-mono text-xs bg-muted/60 px-2.5 py-1 rounded-lg text-foreground/90"
              >
                {n}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function MigrationProgress({
  run,
  error,
  queueName,
  queueIndex,
  queueTotal,
  completed,
  deployServices,
}: {
  run: MigrationRun | null;
  error: string | null;
  queueName: string;
  queueIndex: number;
  queueTotal: number;
  completed: Array<{ name: string; projectId?: string | null }>;
  deployServices?: Array<{ name: string; status: string; error?: string }>;
}) {
  const { t } = useI18n();
  const m = t.migration;
  const runText = m.run as Record<string, string>;
  const status: MigrationStatus = run?.status ?? "queued";
  const order: MigrationStatus[] = [
    "queued",
    "adopting",
    "moving_data",
    "deploying",
    "verifying",
    "awaiting_cutover",
    "cutover",
    "succeeded",
  ];
  const curIdx = order.indexOf(status);
  const failed = status === "failed" || status === "rolled_back";
  const allDone = completed.length >= queueTotal;

  return (
    <div className="py-2 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-foreground">{m.run.title}</h3>
        {queueTotal > 1 && !allDone && (
          <span className="text-xs font-medium text-muted-foreground">
            {interpolate(m.run.queueHeader, {
              index: String(queueIndex + 1),
              total: String(queueTotal),
              name: queueName,
            })}
          </span>
        )}
      </div>

      {queueTotal > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: queueTotal }).map((_, i) => {
            const state = i < completed.length ? "done" : i === queueIndex ? "active" : "pending";
            return (
              <span
                key={i}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${
                  state === "done"
                    ? "bg-success-bg text-success"
                    : state === "active"
                      ? "bg-primary/10 text-primary"
                      : "bg-muted/60 text-muted-foreground"
                }`}
              >
                {state === "done" && <Check className="size-3" />}
                {completed[i]?.name ?? (i === queueIndex ? queueName : `#${i + 1}`)}
              </span>
            );
          })}
        </div>
      )}

      {allDone ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-success rounded-xl bg-success-bg px-4 py-3">
            <CheckCircle2 className="size-5 shrink-0" />
            <span className="font-medium">
              {queueTotal > 1
                ? interpolate(m.run.allSucceeded, { n: String(queueTotal) })
                : m.run.succeeded}
            </span>
          </div>
          <p className="px-1 text-xs leading-relaxed text-muted-foreground/80">{m.run.routeHint}</p>
        </div>
      ) : failed ? (
        <div className="flex items-start gap-2 text-sm text-destructive rounded-xl bg-destructive/10 px-4 py-3">
          <AlertCircle className="size-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">{runText[status]}</p>
            {run?.errorMessage && <p className="mt-1 text-xs opacity-80">{run.errorMessage}</p>}
          </div>
        </div>
      ) : (
        <ol className="space-y-2.5">
          {RUN_PHASES.map((p) => {
            const pIdx = order.indexOf(p);
            const state = curIdx > pIdx ? "done" : curIdx === pIdx ? "active" : "pending";
            return (
              <li key={p} className="flex items-center gap-3 text-sm">
                <span
                  className={`inline-flex items-center justify-center size-5 rounded-full shrink-0 ${
                    state === "done"
                      ? "bg-success-bg text-success"
                      : state === "active"
                        ? "bg-primary/15 text-primary"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {state === "done" ? (
                    <Check className="size-3" />
                  ) : state === "active" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-current" />
                  )}
                </span>
                <span className={state === "pending" ? "text-muted-foreground" : "text-foreground"}>
                  {runText[p]}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {run?.deploymentId &&
        (failed || status === "deploying" || status === "verifying") && (
          <div className="space-y-2">
            <p className="px-0.5 text-xs font-medium text-muted-foreground">{m.run.deployDetail}</p>
            {deployServices && deployServices.length > 0 && (
              <div className="space-y-1 rounded-xl border border-border/50 bg-muted/20 p-2.5">
                {deployServices.map((s) => {
                  const bad = /fail|error|crash|exit/i.test(s.status);
                  const good = /ready|run|succeed|live|deployed|healthy/i.test(s.status);
                  return (
                    <div key={s.name} className="flex items-start gap-2 text-xs">
                      <span
                        className={`mt-1 inline-block size-1.5 shrink-0 rounded-full ${
                          bad ? "bg-danger" : good ? "bg-success" : "bg-muted-foreground"
                        }`}
                      />
                      <span className="font-mono text-foreground">{s.name}</span>
                      <span className="text-muted-foreground">{s.status}</span>
                      {s.error && <span className="min-w-0 flex-1 truncate text-danger">— {s.error}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {/* Native terminal — reuses the /deploy xterm (TerminalSurface +
                useBuildStream attach-only), driven by the run's deploymentId.
                Live while deploying/verifying, persisted logs on failure. */}
            <DeploymentTerminal
              deploymentId={run.deploymentId}
              live={status === "deploying" || status === "verifying"}
              className="h-[360px] w-full overflow-hidden rounded-xl border border-border/50"
            />
          </div>
        )}

      {status === "awaiting_cutover" && (
        <div className="flex items-start gap-2 text-sm rounded-xl bg-success-bg text-success px-4 py-3">
          <CheckCircle2 className="size-4 mt-0.5 shrink-0" />
          <span>{m.run.awaiting_cutover}</span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-sm text-destructive rounded-xl bg-destructive/10 px-4 py-3">
          <AlertCircle className="size-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
