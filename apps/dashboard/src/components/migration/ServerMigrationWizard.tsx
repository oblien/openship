"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  RefreshCw,
  Loader2,
  Database,
  Network,
  AlertTriangle,
  AlertCircle,
  Container,
  Boxes,
  Check,
  X,
  ArrowRight,
  ArrowLeft,
  Trash2,
  CheckCircle2,
  Plus,
  GitBranch,
  Link2,
  Globe,
  ChevronRight,
  ChevronDown,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import {
  dockerMigrationApi,
  deployApi,
  githubApi,
  getApiErrorMessage,
  type DiscoveredStack,
  type DiscoveredGroup,
  type DiscoveredService,
  type ComposeRepoService,
  type OpenshipProjectGroup,
  type MigrationRun,
  type MigrationStatus,
  type TransferProgress,
  type MigrationPreview,
  type CustomPath,
  type PendingItem,
  type ConflictAction,
} from "@/lib/api";
import { useGitHub } from "@/context/GitHubContext";
import { RepositoryList } from "@/app/(dashboard)/library/components/RepositoryList";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Switch } from "@/components/ui/Switch";
import {
  createPublicEndpoint,
  type PublicEndpoint,
} from "@/context/deployment/types";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { randomUUID } from "@/lib/random-uuid";
import { extractOwnerRepoFromUrl } from "@/utils/repoSlug";
import { AppLogo } from "@/components/AppLogo";
import { Logo } from "@/components/logo";
import { DeploymentTerminal } from "@/components/import-project/DeploymentTerminal";
import { ServerConnectionCard } from "@/app/(dashboard)/servers/[serverId]/_components/connection-card";
import { MigrationIllustration } from "@/components/migration/MigrationIllustration";

/** Platforms whose Docker/Compose apps this flow can adopt — shown as faint,
 *  clean brand marks under the intro (decorative). Only brands with a crisp
 *  simpleicons mark (blurry favicon sources dropped); the Openship circle is
 *  appended as the destination. */
const MIGRATE_SOURCES = ["coolify", "caprover", "docker"] as const;

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

/** Synthesize a DiscoveredService-shaped card model from a repo compose service
 *  that has NO running container (e.g. `redis`, or a `build:` app that isn't
 *  running). It renders through the SAME ServiceConfigCard — env from the repo
 *  compose, route controls, no volumes/keep — so a migration screen is the full
 *  native service list, and these services deploy (build/pull) from the repo. */
const synthServiceFromRepo = (c: ComposeRepoService): DiscoveredService => ({
  name: c.name,
  source: "compose",
  running: false,
  image: c.image,
  build: c.build,
  dockerfile: c.dockerfile,
  ports: c.ports ?? [],
  env: c.environment ?? {},
  volumes: [],
  networks: [],
  dependsOn: c.dependsOn ?? [],
  warnings: [],
});

/** How a service is deployed at migration — drives the card badge/color:
 *  reuse = a running container's image is reused (mapped); build = built from
 *  the repo (`build:`); pull = a registry image is pulled (`image:`). */
type DeployAction = "reuse" | "build" | "pull";

/** A card in the migration's deployment plan: a selected running container
 *  (mapped, reused) OR a repo compose service with no container (new, built/
 *  pulled from the repo). `uid` keys the per-service route/env/mode state. */
interface PlanCard {
  uid: string;
  service: DiscoveredService;
  isNew: boolean;
  action: DeployAction;
}

/** Build the deployment-plan card list for a project: every selected running
 *  container, PLUS every linked-repo compose service that has no container
 *  (built/pulled fresh). Mirrors a native compose deploy's service list; the
 *  mapping step is the only migration-specific overlay. */
function buildPlanCards(
  project: ImportProject,
  services: DiscoveredService[],
): PlanCard[] {
  const picked = services.filter((s) => project.services.has(svcUid(s)));
  const cards: PlanCard[] = picked.map((s) => ({
    uid: svcUid(s),
    service: s,
    isNew: false,
    action: "reuse",
  }));
  // Repo compose services with no selected container → deployed from the repo.
  const mappedRepoNames = new Set(
    picked.map((s) => project.serviceMap[svcUid(s)]).filter((n): n is string => !!n),
  );
  const pickedNames = new Set(picked.map((s) => s.name));
  for (const c of project.composeServices) {
    if (mappedRepoNames.has(c.name) || pickedNames.has(c.name)) continue;
    cards.push({
      uid: `new:${c.name}`,
      service: synthServiceFromRepo(c),
      isNew: true,
      action: c.build ? "build" : "pull",
    });
  }
  return cards;
}

/** Stable key for a group — the compose project name, or the standalone sentinel. */
const STANDALONE = "__standalone__";
const groupKey = (g: DiscoveredGroup) => g.project ?? STANDALONE;

const RUN_PHASES: MigrationStatus[] = ["adopting", "moving_data", "deploying", "verifying"];

/** Transfer-mode select values: "" = Settings default (→ direct cross-server),
 *  "stream" = relay via control host. auto/direct/rsync kept for back-compat. */
type TransferModeSel = "" | "auto" | "stream" | "direct" | "rsync";

/** Human byte size (decimal, matches du/rsync byte counts). */
function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

/** A project-level git repo linked to a migrated project. Records the source so
 *  the project can redeploy / push auto-deploy later — the running image is
 *  still reused during the migrate (no rebuild). GitHub only in v1. */
interface RepoLink {
  provider: "github";
  owner: string;
  repo: string;
  branch: string;
}

/**
 * One Openship project to create from the scan. A project maps to AT MOST one
 * compose (or a set of standalone containers) — you can't merge two composes.
 * `bound` is the group key its services belong to (null until the first pick).
 */
interface ImportProject {
  id: string;
  name: string;
  /** True once the user typed a name — stops the auto-derive (from the selected
   *  stack) from overwriting it. False = name still tracks the picked stack. */
  nameEdited: boolean;
  services: Set<string>;
  bound: string | null;
  /** Optional project-level repo (step 2 "source"). */
  repo: RepoLink | null;
  /** Parsed services from the linked repo's docker-compose (step 2 reference). */
  composeServices: ComposeRepoService[];
  /** svcUid → matched compose service name (step 2 map). null/absent = not in repo.
   *  The matched service's build context becomes that service's rootDirectory. */
  serviceMap: Record<string, string | null>;
  /** svcUid → env override, seeded from the discovered container (step 3 edit). */
  serviceEnvs: Record<string, Record<string, string>>;
  /** svcUid → public routes to apply after verify (step 3). Client-only. */
  serviceRoutes: Record<string, PublicEndpoint[]>;
  /** svcUid → route choice (step 3). Default derived: "keep" when the container
   *  has a detected existingRoute, else "none". Free/Custom edit serviceRoutes. */
  serviceRouteMode: Record<string, RouteMode>;
}

/** Per-container route choice on step 3. */
type RouteMode = "keep" | "free" | "custom" | "none";

/** Same-server volume ownership per service: "reuse" (take over in place, the
 *  default) or "copy" (duplicate into a new Openship volume, keep the original). */
type VolumeStrategy = "reuse" | "copy";

interface MigrateItem {
  name: string;
  serviceNames: string[];
  /** serviceName → "copy" (only copy entries are sent; reuse is the default). */
  volumeStrategies: Record<string, VolumeStrategy>;
  /** Project-level repo to link (records source; sent to the migrate API). */
  gitSource?: { provider: "github"; owner: string; repo: string; branch?: string };
  /** serviceName → build subpath (sent to the migrate API). */
  serviceSubpaths?: Record<string, string>;
  /** discovered serviceName → repo compose service name (step-2 map, sent to the
   *  migrate API so the adopted row is named after the repo service). */
  serviceRenames?: Record<string, string>;
  /** serviceName → env override (sent to the migrate API). */
  serviceEnv?: Record<string, Record<string, string>>;
  /** serviceName → routes to apply AFTER the run verifies (client-only, NOT sent). */
  routesByServiceName?: Record<string, PublicEndpoint[]>;
}

const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A discovered service has a foreign-proxy route worth keeping (≥1 domain). */
const hasKeepableRoute = (s: Pick<DiscoveredService, "existingRoute">) =>
  !!s.existingRoute?.some((r) => r.domains.length > 0);

/** Best-effort auto-match a discovered container name to a repo compose service:
 *  exact normalized match, else the discovered name ending with / containing the
 *  compose name (handles the `openship-<group>-<svc>` prefix). null = no match. */
function autoMatchCompose(discoveredName: string, composeNames: string[]): string | null {
  const dn = normalizeName(discoveredName);
  const exact = composeNames.find((c) => normalizeName(c) === dn);
  if (exact) return exact;
  const fuzzy = composeNames
    .filter((c) => normalizeName(c).length >= 3)
    .find((c) => dn.endsWith(normalizeName(c)) || dn.includes(normalizeName(c)));
  return fuzzy ?? null;
}

/** Env Record ↔ editor rows — the same bridge ComposeServices uses so the reused
 *  EnvironmentVariables editor (settings mode) can edit a compose env map. */
const envToRows = (env: Record<string, string>) =>
  Object.entries(env).map(([key, value]) => ({ key, value, visible: false }));
const rowsToEnv = (rows: Array<{ key: string; value: string }>) => {
  const env: Record<string, string> = {};
  for (const { key, value } of rows) if (key) env[key] = value;
  return env;
};

/** Map the wizard's per-service endpoints → the server route spec sent to
 *  migrate() (published SERVER-SIDE post-verify). Takes the first endpoint with a
 *  resolved domain per service and carries its `targetPath` so a path-fan-out
 *  domain (e.g. `/v3` → this service) is preserved; the server groups by domain. */
type ServerRouteSpec = {
  exposedPort?: string;
  domainType: "free" | "custom";
  domain?: string;
  customDomain?: string;
  targetPath?: string;
};
function toServerRoutes(
  routes: Record<string, PublicEndpoint[]> | undefined,
): Record<string, ServerRouteSpec> | undefined {
  if (!routes) return undefined;
  const out: Record<string, ServerRouteSpec> = {};
  for (const [name, endpoints] of Object.entries(routes)) {
    const ep = endpoints[0];
    if (!ep) continue;
    const domain = (ep.domainType === "custom" ? ep.customDomain : ep.domain)?.trim().toLowerCase();
    if (!domain) continue;
    const targetPath = ep.targetPath?.trim();
    out[name] = {
      domainType: ep.domainType === "custom" ? "custom" : "free",
      ...(ep.domainType === "custom" ? { customDomain: domain } : { domain }),
      ...(ep.port ? { exposedPort: String(ep.port) } : {}),
      ...(targetPath && targetPath !== "/" ? { targetPath } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

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
  variant = "modal",
  server,
  initialRunId,
  onBack,
}: {
  isOpen?: boolean;
  onClose: () => void;
  serverId?: string;
  /** "modal" (Library, default) wraps in a Modal; "tab" renders an inline
   *  two-column layout for the server-detail Migrations tab (left = discovered
   *  containers, right = the connection card until a scan swaps in the config). */
  variant?: "modal" | "tab";
  /** Connection summary for the tab's right column before a scan (server detail). */
  server?: { sshHost: string; sshPort?: number | null; sshUser?: string | null; sshAuthMethod?: string | null } | null;
  /** Open directly on an existing run's progress/steps/logs (any status,
   *  incl. terminal) — the Migrations list opens a row straight into this. */
  initialRunId?: string;
  /** Tab variant: renders a compact inline "← Back" (to the runs list) in the
   *  header rows, so it never adds a full row that pushes the layout down. */
  onBack?: () => void;
}) {
  const { t } = useI18n();
  const m = t.migration;
  const router = useRouter();
  const github = useGitHub();

  // Wizard step for the adopt/migrate flow: select services → link source →
  // domains/routes → migrate. Only gates the `adoptable && stack` screen; the
  // re-import, flat-docker, and progress branches are step-agnostic.
  const [step, setStep] = useState<"select" | "source" | "domains" | "plan">("select");

  // Each step's content is a very different height; without resetting scroll a
  // step change (esp. Next from a scrolled-down list) leaves the viewport parked
  // in empty space. Bring the current step's top back into view (tab variant).
  const stepTopRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stepTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [step]);

  const [selectedId, setSelectedId] = useState<string | null>(serverId ?? null);
  const [targetId, setTargetId] = useState<string | null>(serverId ?? null);
  const [serverName, setServerName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // "Flat Docker" scan mode: ignore openship.* labels so managed workloads adopt
  // as plain compose/standalone (no re-import). Off = Openship-aware (default).
  const [flatDocker, setFlatDocker] = useState(false);
  const [scanStatus, setScanStatus] = useState<string>("");
  const [stack, setStack] = useState<DiscoveredStack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [killOriginals, setKillOriginals] = useState(false);
  // "" = use the user's Settings default (send nothing); else per-run override.
  const [transferMode, setTransferMode] = useState<TransferModeSel>("");
  // On-the-wire rsync compression (direct cross-server) — opt-in.
  const [compress, setCompress] = useState(false);
  // User-added extra paths to move (source host path → target host path).
  const [customPaths, setCustomPaths] = useState<CustomPath[]>([]);
  // serviceName → target-volume conflict resolution chosen at the plan step.
  const [conflictResolution, setConflictResolution] = useState<Record<string, ConflictAction>>({});
  // The transfer plan must be loaded before Migrate (it's what the move acts
  // on). Set by TransferPlanSummary once the scan resolves; gates the plan step.
  const [planReady, setPlanReady] = useState(false);

  // Project id whose repo compose is currently being parsed (step 2 spinner).
  const [parsingRepo, setParsingRepo] = useState<string | null>(null);

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
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  // Per-service status peek (the failure rows). Full logs are shown by the
  // embedded DeploymentTerminal (its own build-session stream), not here.
  const [deploy, setDeploy] = useState<{
    services?: Array<{ name: string; status: string; error?: string }>;
  } | null>(null);
  const [cutoverBusy, setCutoverBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Transfer-plan previews cached by request key, so navigating Back/Next
  // doesn't re-hit the server (the scan `du`s volumes — expensive). Cleared on
  // reset(); a changed key (new services / custom paths) fetches fresh.
  const planCacheRef = useRef<Map<string, MigrationPreview>>(new Map());

  const reset = () => {
    setStep("select");
    setStack(null);
    setError(null);
    setProjects([]);
    setActiveId(null);
    setVolumeStrategy({});
    setScanning(false);
    setKillOriginals(false);
    setTransferMode("");
    setCompress(false);
    setCustomPaths([]);
    setConflictResolution({});
    planCacheRef.current.clear();
    setQueue(null);
    setQueueIndex(0);
    setCompleted([]);
    setStarting(false);
    setMigrationId(null);
    setConfirmToken(null);
    setRun(null);
    setProgress(null);
    setCutoverBusy(false);
    setConfirmingDelete(false);
    setDeleteBusy(false);
  };

  const close = () => {
    reset();
    if (!serverId) setSelectedId(null);
    onClose();
  };

  // The run-panel "Cancel": abort the server pipeline (kills the transfer +
  // rolls back) when the run is still active, then drop the client UI. On a
  // terminal/failed run it's just "Close".
  const cancelRun = () => {
    const active = run && !["succeeded", "failed", "rolled_back"].includes(run.status);
    if (migrationId && active) void dockerMigrationApi.cancel(migrationId).catch(() => {});
    close();
  };

  // Delete a terminal run's record (project + data untouched); returns to the
  // list via close(). Two-step inline confirm to avoid an accidental wipe.
  const deleteRun = async () => {
    if (!migrationId) return;
    setDeleteBusy(true);
    try {
      await dockerMigrationApi.remove(migrationId);
      close();
    } catch {
      setDeleteBusy(false);
      setConfirmingDelete(false);
    }
  };

  // Failed → "Remove copied data from target": wipe the volumes this run copied
  // to the target (orphaned after rollback) so a retry starts clean. Source is
  // untouched. Clears the local flag so the button disappears once done.
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const cleanupTarget = async () => {
    if (!migrationId) return;
    setCleanupBusy(true);
    try {
      await dockerMigrationApi.cleanupTarget(migrationId);
      setRun((prev) => (prev ? { ...prev, targetVolumes: [] } : prev));
    } catch {
      /* best-effort */
    } finally {
      setCleanupBusy(false);
    }
  };

  // Failed → "Edit & retry": drop back into a fresh flow on the SAME server
  // with the prior custom paths restored, re-scan, and let the user adjust
  // (services / env / paths) before re-running. The failed run's record stays.
  const editRetry = () => {
    const snap = run?.inputSnapshot as { customPaths?: CustomPath[] } | null | undefined;
    const paths = Array.isArray(snap?.customPaths) ? snap!.customPaths! : [];
    reset();
    setCustomPaths(paths);
    void handleScan();
  };

  const pickServer = (s: ServerOption | null) => {
    setSelectedId(s?.id ?? null);
    setServerName(s?.name ?? null);
    reset();
    setTargetId(s?.id ?? null);
  };

  const handleScan = async (flatOverride?: boolean) => {
    if (!selectedId) return;
    const flat = flatOverride ?? flatDocker;
    setScanning(true);
    setScanStatus("");
    setError(null);
    setStack(null);
    setProjects([]);
    setStep("select");
    try {
      // Stream the inspect (SSE): step progress + no fixed timeout, so a slow
      // SSH + docker inspect doesn't get aborted (the old plain POST hit the
      // 15s client default through the same-origin proxy).
      const scanned = await dockerMigrationApi.scanStream(selectedId, {
        onProgress: setScanStatus,
        flatDocker: flat,
      });
      setStack(scanned);
      if (!scanned.adoptable) {
        setError(m.discover.nothing);
        return;
      }
      // Seed ONE project from the first group (compose preferred). Pre-select the
      // whole group ONLY when it's a real compose project (a cohesive unit);
      // standalone containers have no natural grouping, so start empty and let the
      // user pick first. The user adds more project tabs for the rest.
      // Seed ONE EMPTY project — NEVER auto-select a group or its services.
      // Auto-picking the first group previously pinned ITS name/identity (e.g.
      // "n8n") onto a DIFFERENT stack the user actually chose, and shipped a
      // 1-service "app" instead of the multi-service stack. The user picks the
      // stack; the name derives from that selection (toggleService/toggleGroup).
      const hasCandidate = scanned.groups.some((g) => g.services.some((s) => !isExcluded(s)));
      if (hasCandidate) {
        setProjects([
          {
            id: randomUUID(),
            name: "",
            nameEdited: false,
            services: new Set(),
            bound: null,
            repo: null,
            composeServices: [],
            serviceMap: {},
            serviceEnvs: {},
            serviceRoutes: {},
            serviceRouteMode: {},
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

  const addProject = () => {
    const p: ImportProject = {
      id: randomUUID(),
      name: "", // derived from the stack the user picks (never auto-guessed)
      nameEdited: false,
      services: new Set(),
      bound: null,
      repo: null,
      composeServices: [],
      serviceMap: {},
      serviceEnvs: {},
      serviceRoutes: {},
      serviceRouteMode: {},
    };
    setProjects((prev) => [...prev, p]);
    setActiveId(p.id);
  };

  // Link/unlink the repo. Clearing it drops the parsed compose + the map.
  const setProjectRepo = (id: string, repo: RepoLink | null) =>
    setProjects((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, repo, ...(repo ? {} : { composeServices: [], serviceMap: {} }) } : p,
      ),
    );

  // Store the parsed compose services + an auto-computed discovered→compose map.
  const setProjectCompose = (
    id: string,
    composeServices: ComposeRepoService[],
    serviceMap: Record<string, string | null>,
  ) => setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, composeServices, serviceMap } : p)));

  const setServiceMap = (id: string, uid: string, composeName: string | null) =>
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, serviceMap: { ...p.serviceMap, [uid]: composeName } } : p)),
    );

  const setServiceEnv = (id: string, uid: string, env: Record<string, string>) =>
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, serviceEnvs: { ...p.serviceEnvs, [uid]: env } } : p)),
    );

  // Always store the full endpoint list (never delete). An empty-domain endpoint
  // means "internal / not published"; the domain-non-empty filter is applied at
  // payload build + publish, NOT here — deleting mid-edit is what made route
  // clicks snap back (the card's `routes` prop would flip to undefined).
  const setServiceRoutes = (id: string, uid: string, routes: PublicEndpoint[]) =>
    setProjects((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, serviceRoutes: { ...p.serviceRoutes, [uid]: routes } } : p,
      ),
    );

  const setServiceRouteMode = (id: string, uid: string, mode: RouteMode) =>
    setProjects((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, serviceRouteMode: { ...p.serviceRouteMode, [uid]: mode } } : p,
      ),
    );

  /** A route with a domain filled in for its active type (the publish predicate). */
  const routeHasDomain = (e: PublicEndpoint) =>
    (e.domainType === "custom" ? e.customDomain : e.domain).trim().length > 0;

  // Link/unlink the repo AND parse its compose → auto-map the project's selected
  // discovered services to the parsed compose services (step 2). One handler for
  // both linking and branch changes (both re-parse).
  const onRepoChange = async (projectId: string, repo: RepoLink | null) => {
    setProjectRepo(projectId, repo);
    if (!repo) return;
    setParsingRepo(projectId);
    try {
      const res = await dockerMigrationApi.parseRepoCompose(repo.owner, repo.repo, repo.branch);
      const services = res?.services ?? [];
      const names = services.map((s) => s.name);
      const proj = projects.find((p) => p.id === projectId);
      const map: Record<string, string | null> = {};
      for (const s of stack?.services ?? []) {
        if (proj?.services.has(svcUid(s))) map[svcUid(s)] = autoMatchCompose(s.name, names);
      }
      setProjectCompose(projectId, services, map);
    } catch {
      setProjectCompose(projectId, [], {});
    } finally {
      setParsingRepo(null);
    }
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
    // Typing a name (non-empty) marks it user-owned so the auto-derive stops
    // overwriting it; clearing the box re-enables derive-from-selection.
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name, nameEdited: name.trim().length > 0 } : p)),
    );

  /** Project name derived from the SELECTED stack: the bound compose group's
   *  name, else the server name. Never the first-discovered group. */
  const deriveName = (bound: string | null) =>
    bound && bound !== STANDALONE ? bound : (serverName ?? "");

  /** Free select: a project can pull services from ANY compose group. The old
   *  one-compose-per-project guard (which dimmed other groups with "add a
   *  separate project to import it") is relaxed — everything is selectable into
   *  the active project. `bound` is still tracked, but only to auto-derive the
   *  project name from the first group picked. */
  const canBind = (_key: string) => true;

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
        const nextBound = services.size ? (p.bound ?? key) : null;
        return {
          ...p,
          services,
          bound: nextBound,
          name: p.nameEdited ? p.name : deriveName(nextBound),
        };
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
        const nextBound = services.size ? (p.bound ?? key) : null;
        return {
          ...p,
          services,
          bound: nextBound,
          name: p.nameEdited ? p.name : deriveName(nextBound),
        };
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
  // Cross-server now MOVES locally-built images as data (docker save|load) — no
  // registry, no rebuild. Surface an info note up front (the image stream can be
  // large/slow) when a built service exists and a different target is picked.
  const crossServerBuiltInfo = !sameServer && Boolean(stack?.services.some((s) => Boolean(s.build)));
  const migratable = projects.filter((p) => p.services.size > 0 && p.name.trim().length > 0);
  // Union of all migratable service names (uid→name), for the transfer-plan scan.
  const planServiceNames = useMemo(
    () =>
      Array.from(
        new Set(
          migratable.flatMap((p) =>
            (stack?.services ?? []).filter((s) => p.services.has(svcUid(s))).map((s) => s.name),
          ),
        ),
      ),
    [migratable, stack],
  );
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
        transferCompression: compress ? "zstd" : undefined,
        customPaths: customPaths.length ? customPaths : undefined,
        // Publish domains SERVER-SIDE (was a client-only effect, lost when the
        // wizard unmounted or a run was opened from the list). Map each
        // service's chosen endpoint → the server route spec.
        routesByServiceName: toServerRoutes(item.routesByServiceName),
        conflictResolution: Object.keys(conflictResolution).length ? conflictResolution : undefined,
        gitSource: item.gitSource,
        serviceSubpaths: item.serviceSubpaths,
        serviceRenames: item.serviceRenames,
        serviceEnv: item.serviceEnv,
        flatDocker,
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
    const items: MigrateItem[] = migratable.map((p) => {
      const picked = (stack?.services ?? []).filter((s) => p.services.has(svcUid(s)));
      const volumeStrategies: Record<string, VolumeStrategy> = {};
      if (sameServer) {
        for (const s of picked) {
          if (volumeStrategy[svcUid(s)] === "copy") volumeStrategies[s.name] = "copy";
        }
      }
      // Resolve the per-service maps from svcUid keys → service names (what the
      // API + the post-verify apply key on). The build subpath is DERIVED from
      // the discovered→compose mapping (matched compose service's build context).
      const composeByName = new Map(p.composeServices.map((c) => [c.name, c]));
      const serviceSubpaths: Record<string, string> = {};
      const serviceRenames: Record<string, string> = {};
      const serviceEnv: Record<string, Record<string, string>> = {};
      const routesByServiceName: Record<string, PublicEndpoint[]> = {};
      for (const s of picked) {
        const mapped = p.serviceMap[svcUid(s)];
        const build = mapped ? composeByName.get(mapped)?.build?.trim() : undefined;
        if (build) serviceSubpaths[s.name] = build;
        // Adopt the row under the mapped REPO compose service name so a later
        // git-compose reconcile matches it in place (no duplicate / empty volume).
        if (mapped && mapped !== s.name) serviceRenames[s.name] = mapped;
        const env = p.serviceEnvs[svcUid(s)];
        if (env) serviceEnv[s.name] = env; // only edited services carry an override
        // Resolve the route by the per-container mode. "keep" reuses the domain
        // the foreign proxy already served; free/custom take the editor value
        // (domain-less placeholders filtered here, not mid-edit); none → skip.
        const uid = svcUid(s);
        const mode: RouteMode = p.serviceRouteMode[uid] ?? (hasKeepableRoute(s) ? "keep" : "none");
        let routes: PublicEndpoint[] = [];
        if (mode === "keep" && hasKeepableRoute(s)) {
          // One endpoint per detected route so a path-fan-out domain is kept:
          // each entry carries its location path (→ targetPath, root omitted).
          routes = (s.existingRoute ?? [])
            .filter((r) => r.domains.length > 0)
            .map((r) =>
              createPublicEndpoint({
                port: firstContainerPort(s),
                domainType: "custom",
                customDomain: r.domains[0],
                ...(r.path && r.path !== "/" ? { targetPath: r.path } : {}),
              }),
            );
        } else if (mode === "free" || mode === "custom") {
          routes = (p.serviceRoutes[uid] ?? []).filter(routeHasDomain);
        }
        if (routes.length) routesByServiceName[s.name] = routes;
      }
      // Repo compose services with no running container (built/pulled fresh from
      // the repo): carry their route + env override keyed by the REPO service
      // name. The backend creates the row (reconcileFromCompose) and publishRoutes
      // routes it by that name — so they deploy and route like any native service.
      const mappedRepoNames = new Set(
        picked.map((s) => p.serviceMap[svcUid(s)]).filter((n): n is string => !!n),
      );
      const pickedNames = new Set(picked.map((s) => s.name));
      for (const c of p.composeServices) {
        if (mappedRepoNames.has(c.name) || pickedNames.has(c.name)) continue;
        const uid = `new:${c.name}`;
        const env = p.serviceEnvs[uid];
        if (env) serviceEnv[c.name] = env;
        const mode = p.serviceRouteMode[uid] ?? "none";
        if (mode === "free" || mode === "custom") {
          const routes = (p.serviceRoutes[uid] ?? []).filter(routeHasDomain);
          if (routes.length) routesByServiceName[c.name] = routes;
        }
      }
      return {
        name: p.name.trim(),
        serviceNames: picked.map((s) => s.name),
        volumeStrategies,
        gitSource: p.repo
          ? { provider: "github" as const, owner: p.repo.owner, repo: p.repo.repo, branch: p.repo.branch }
          : undefined,
        serviceSubpaths: Object.keys(serviceSubpaths).length ? serviceSubpaths : undefined,
        serviceRenames: Object.keys(serviceRenames).length ? serviceRenames : undefined,
        serviceEnv: Object.keys(serviceEnv).length ? serviceEnv : undefined,
        routesByServiceName: Object.keys(routesByServiceName).length ? routesByServiceName : undefined,
      };
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
    // Routes/domains are published SERVER-SIDE now (see toServerRoutes in the
    // migrate payload), so they land even if this effect never runs (wizard
    // unmounted / run opened from the list). Here we only advance the queue.
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

  // Domains land automatically when a migrated service carried a route (a kept
  // foreign-proxy domain or a free/custom one added in step 3) — those get
  // applied on verify (see applyRoutes above). Only nag "Add domains" when
  // NOTHING got a domain; otherwise the stack is already public, so the done
  // screen leads with "Open project" instead.
  const anyDomainAssigned = Boolean(
    queue?.some((it) => it.routesByServiceName && Object.keys(it.routesByServiceName).length > 0),
  );

  const lastProjectId = () => completed[completed.length - 1]?.projectId ?? run?.projectId;

  // Navigate-away actions reset (not close()) so the page variant doesn't fire
  // onClose's back-nav-to-server before the real destination push. The route
  // change unmounts the wizard regardless, so a modal needs no explicit onClose.
  const openProject = () => {
    const pid = lastProjectId();
    if (pid) {
      reset();
      router.push(`/projects/${pid}`);
    } else {
      close();
    }
  };

  // The natural next step: assign a domain per exposed service (the migrated
  // apps are pre-exposed, no domain yet) on the project's Domains tab. Adding a
  // domain + redeploying is what ensures OpenResty (and reclaims 80/443 from the
  // old proxy via the takeover modal).
  const openDomains = () => {
    const pid = lastProjectId();
    if (pid) {
      reset();
      router.push(`/projects/${pid}/domains`);
    } else {
      close();
    }
  };

  // On a deploy/verify failure the run row only carries a one-line reason. The
  // real stepper, full logs, and per-service failure detail live on the target
  // deployment's build screen — deep-link to it so "just failed" isn't a
  // dead-end. (Only meaningful once the deploy started, i.e. deploymentId set.)
  const openDeployLogs = () => {
    const depId = run?.deploymentId;
    if (!depId) return;
    reset();
    router.push(`/build/${depId}`);
  };

  // Open directly on a specific run (a row clicked in the Migrations list) —
  // seed the same state the progress view + poll need, for ANY status incl.
  // terminal. Wins over the in-flight re-attach below (guarded by initialRunId).
  // The token (for a cutover) rides the active-run endpoint when this run is live.
  useEffect(() => {
    if (!initialRunId || migrationId === initialRunId) return;
    setQueue([{ name: "", serviceNames: [], volumeStrategies: {} }]);
    setQueueIndex(0);
    setCompleted([]);
    setMigrationId(initialRunId);
    setRun(null);
    setConfirmToken(null);
    if (serverId) {
      void dockerMigrationApi
        .getActive(serverId)
        .then((a) => setConfirmToken(a.confirmationToken))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRunId]);

  // Re-attach after a CLIENT reload: the run is server-side, so if one is in
  // flight for this server, re-find it and re-seed the state the progress
  // screen + poll need (queue placeholder flips `inProgress`; confirmToken is
  // required for the cutover buttons and is never persisted client-side).
  useEffect(() => {
    if (!serverId || queue || initialRunId) return; // `queue`/`initialRunId` ⇒ already targeting a run
    let live = true;
    void dockerMigrationApi
      .getActive(serverId)
      .then((res) => {
        if (!live || !res.run) return;
        setQueue([{ name: res.run.projectName ?? "", serviceNames: [], volumeStrategies: {} }]);
        setQueueIndex(0);
        setCompleted([]);
        setMigrationId(res.run.id);
        setConfirmToken(res.confirmationToken);
        setRun(res.run);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  // Poll the current run while a migration is in flight; stop once terminal.
  useEffect(() => {
    if (!migrationId) return;
    if (run && ["succeeded", "failed", "rolled_back"].includes(run.status)) return;
    let live = true;
    const tick = async () => {
      try {
        const res = await dockerMigrationApi.getMigration(migrationId);
        if (live) {
          setRun(res.run);
          setProgress(res.progress ?? null);
        }
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

  // Live progress SSE — a smooth, real-time transfer bar (the 2.5s poll above is
  // coarse). The poll stays the authoritative run/log source, so a dropped
  // stream degrades to it rather than stalling. Server closes the stream on the
  // terminal event; opening a finished run just gets a snapshot + close.
  useEffect(() => {
    if (!migrationId) return;
    const stop = dockerMigrationApi.streamMigration(migrationId, {
      onProgress: (u) => setProgress(u),
    });
    return stop;
  }, [migrationId]);

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

  // "Flat Docker" scan mode. One handler, two shells: an option row inside the
  // scan / Select card (tab variant — it belongs with the scan controls, not in
  // the header), and an inline switch beside the modal's scan button. Flipping it
  // re-scans when results are already shown.
  const setFlat = (next: boolean) => {
    setFlatDocker(next);
    if (selectedId && stack) void handleScan(next);
  };

  /** Bordered option row: label (+ one-line hint) with the shared Switch. The
   *  hint is `truncate`d so no locale can grow the card past two lines — the
   *  full explanation stays on the row's tooltip. */
  const flatOption = (withHint: boolean) => (
    <div
      className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/10 px-3.5 py-2.5"
      title={m.wizard.flatDockerHint}
    >
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-foreground">{m.wizard.flatDocker}</p>
        {withHint && (
          <p className="truncate text-xs text-muted-foreground">{m.wizard.flatDockerShort}</p>
        )}
      </div>
      <Switch
        size="sm"
        checked={flatDocker}
        disabled={scanning}
        onChange={setFlat}
        ariaLabel={m.wizard.flatDocker}
      />
    </div>
  );

  const flatInline = (
    <div
      className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"
      title={m.wizard.flatDockerHint}
    >
      <Switch
        size="sm"
        checked={flatDocker}
        disabled={scanning}
        onChange={setFlat}
        ariaLabel={m.wizard.flatDocker}
      />
      {m.wizard.flatDocker}
    </div>
  );

  // "← Back to migrations" (tab variant only) — rendered on its own line above
  // the project tabs: it leaves the flow, so it shouldn't share a row with the
  // controls that act inside it.
  const backBtn = onBack ? (
    <button
      type="button"
      onClick={onBack}
      className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      {m.tab.back}
    </button>
  ) : null;

  // Compact header lives inside the modal shell only; the page route renders its
  // own Jobs-style header above the wizard.
  const modalHeader = (
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
  );

  const body = inProgress ? (
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
                hasDomains={anyDomainAssigned}
                progress={progress}
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
                      className={
                        anyDomainAssigned
                          ? "inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
                          : "px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                      }
                    >
                      {anyDomainAssigned && <ArrowRight className="size-4" />}
                      {m.run.openProject}
                    </button>
                    {!anyDomainAssigned && (
                      <button
                        type="button"
                        onClick={openDomains}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:hover:shadow-none disabled:hover:translate-y-0"
                      >
                        <ArrowRight className="size-4" />
                        {m.run.addDomains}
                      </button>
                    )}
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
                      onClick={cancelRun}
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
                      className={`group inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                        on
                          ? "bg-muted text-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-muted/40"
                      }`}
                      onClick={() => setActiveId(p.id)}
                    >
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
                <div className="h-full min-h-0 flex flex-col gap-4">
                  {/* ── Step 1: SELECT the containers + (optional) link a repo. The
                      full discovered grid lives ONLY here. ── */}
                  {step === "select" && (
                    <div className="grid h-full min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                      <aside className="flex min-h-0 min-w-0 flex-col">
                        <p className="mb-2 shrink-0 px-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {m.discover.servicesTitle}
                        </p>
                        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto pe-1.5">
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
                      </aside>

                      <section className="flex min-h-0 min-w-0 flex-col lg:border-s lg:border-border/50 lg:ps-6">
                        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto pe-1">
                          <div className="space-y-1.5">
                            <label className="text-[13px] font-medium text-muted-foreground">
                              {m.wizard.projectName}
                            </label>
                            <input
                              value={active.name}
                              onChange={(e) => renameProject(active.id, e.target.value)}
                              placeholder={m.wizard.projectNamePlaceholder}
                              className="w-full px-3.5 py-2.5 rounded-xl bg-card border border-border text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
                            />
                          </div>
                          <RepoSourceCard
                            project={active}
                            github={github}
                            parsing={parsingRepo === active.id}
                            onRepoChange={(repo) => void onRepoChange(active.id, repo)}
                          />
                        </div>
                      </section>
                    </div>
                  )}

                  {/* ── Step 2: MAP — only the selected containers ↔ the repo's
                      compose services. No grid, no unselected containers. ── */}
                  {step === "source" && (
                    <div className="h-full min-h-0 flex-1 overflow-y-auto pe-1">
                      <ServiceMapPanel
                        project={active}
                        stack={stack}
                        parsing={parsingRepo === active.id}
                        onSetMap={(uid, name) => setServiceMap(active.id, uid, name)}
                      />
                    </div>
                  )}

                  {/* ── Step 3: CONFIGURE — one card per selected container: its
                      route, volume, and env. Nothing else. ── */}
                  {step === "domains" && (
                    <div className="h-full min-h-0 flex-1 overflow-y-auto pe-1">
                      <div className="grid gap-4 items-start grid-cols-[repeat(auto-fill,minmax(420px,1fr))]">
                        {buildPlanCards(active, stack.services).map(({ uid, service, isNew, action }) => (
                          <ServiceConfigCard
                            key={uid}
                            service={service}
                            sourceServerId={selectedId}
                            isNew={isNew}
                            deployAction={action}
                            routes={active.serviceRoutes[uid]}
                            envOverride={active.serviceEnvs[uid]}
                            sameServer={sameServer}
                            volumeStrategy={volumeStrategy[uid]}
                            routeMode={
                              active.serviceRouteMode[uid] ??
                              (hasKeepableRoute(service) ? "keep" : "none")
                            }
                            onSetRoutes={(r) => setServiceRoutes(active.id, uid, r)}
                            onSetEnv={(env) => setServiceEnv(active.id, uid, env)}
                            onSetStrategy={(strat) =>
                              setVolumeStrategy((prev) => ({ ...prev, [uid]: strat }))
                            }
                            onSetRouteMode={(mode) => setServiceRouteMode(active.id, uid, mode)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {step === "plan" && (
                    <div className="h-full min-h-0 flex-1 overflow-y-auto pe-1">
                      <TransferPlanSummary
                        sourceId={selectedId}
                        targetId={targetId}
                        serviceNames={planServiceNames}
                        transferMode={transferMode}
                        setTransferMode={setTransferMode}
                        compress={compress}
                        setCompress={setCompress}
                        customPaths={customPaths}
                        setCustomPaths={setCustomPaths}
                        conflictResolution={conflictResolution}
                        setConflictResolution={setConflictResolution}
                        cache={planCacheRef}
                        onReady={setPlanReady}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Scan failed (no stack) → same compact "nothing found" frame. */}
              {error && !stack && <NoResults message={error} isError />}
            </div>

            {/* Footer: target + cutover + migrate */}
            <div className="shrink-0 flex items-center justify-between gap-4 px-6 py-4 border-t border-border/60">
              {adoptable && stack ? (
                step === "select" ? (
                  /* Step 1 footer: flat toggle + rescan + Cancel + Next */
                  <>
                    {flatInline}
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleScan()}
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
                        onClick={() => setStep("source")}
                        disabled={migratable.length === 0}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:hover:shadow-none disabled:hover:translate-y-0 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {m.wizard.steps.next}
                        <ArrowRight className="size-4" />
                      </button>
                    </div>
                  </>
                ) : step === "source" ? (
                  /* Step 2 footer: Back + Next */
                  <>
                    <span className="text-xs text-muted-foreground min-w-0">{m.wizard.steps.sourceHint}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setStep("select")}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                      >
                        <ArrowLeft className="size-4" />
                        {m.wizard.steps.back}
                      </button>
                      <button
                        type="button"
                        onClick={() => setStep("domains")}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:hover:shadow-none disabled:hover:translate-y-0"
                      >
                        {m.wizard.steps.next}
                        <ArrowRight className="size-4" />
                      </button>
                    </div>
                  </>
                ) : step === "domains" ? (
                  /* Step 3 footer: move settings + Back + (Next cross / Migrate same) */
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
                      <span
                        className={`text-xs ${sameServer ? "text-muted-foreground" : "text-warning"}`}
                      >
                        {sameServer ? m.wizard.sameServer : m.run.downtimeNote}
                      </span>
                      {crossServerBuiltInfo && (
                        <span className="text-xs text-muted-foreground w-full">{m.wizard.crossServerBuiltInfo}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setStep("source")}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                      >
                        <ArrowLeft className="size-4" />
                        {m.wizard.steps.back}
                      </button>
                      {sameServer ? (
                        <button
                          type="button"
                          onClick={handleMigrate}
                          disabled={!canMigrate}
                          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:hover:shadow-none disabled:hover:translate-y-0 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {starting ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                          {migratable.length > 1
                            ? interpolate(m.wizard.migrateN, { n: String(migratable.length) })
                            : m.wizard.migrate}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setStep("plan")}
                          disabled={!canMigrate}
                          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:hover:shadow-none disabled:hover:translate-y-0 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {m.wizard.steps.next}
                          <ArrowRight className="size-4" />
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  /* Plan footer: Back → Configure + Migrate. */
                  <>
                    <span className="text-xs text-muted-foreground min-w-0 flex-1">
                      {sameServer ? m.wizard.sameServer : m.run.downtimeNote}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setStep("domains")}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                      >
                        <ArrowLeft className="size-4" />
                        {m.wizard.steps.back}
                      </button>
                      <button
                        type="button"
                        onClick={handleMigrate}
                        disabled={!canMigrate || !planReady}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:hover:shadow-none disabled:hover:translate-y-0 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {starting ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                        {migratable.length > 1
                          ? interpolate(m.wizard.migrateN, { n: String(migratable.length) })
                          : m.wizard.migrate}
                      </button>
                    </div>
                  </>
                )
              ) : (
                <>
                  {flatInline}
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
                      onClick={() => handleScan()}
                      disabled={!selectedId || scanning}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:hover:shadow-none disabled:hover:translate-y-0 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {scanning ? <Loader2 className="size-4 animate-spin" /> : stack ? <RefreshCw className="size-4" /> : <Search className="size-4" />}
                      {scanning ? m.wizard.scanning : stack ? m.wizard.rescan : m.wizard.scan}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        );

  if (variant === "tab") {
    // Inline Services-tab layout: LEFT = discovered containers (scan controls +
    // project tabs + grid); RIGHT = the connection card until a scan swaps in the
    // stepped migrate config (or the live progress). Reuses every sub-component
    // and all wizard state — same flow as the modal, just laid out for the page.
    const rescanBtn = (
      <button
        type="button"
        onClick={() => handleScan()}
        disabled={!selectedId || scanning}
        title={m.wizard.rescan}
        aria-label={m.wizard.rescan}
        className="p-2.5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {scanning ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
      </button>
    );

    // Live migration → two-column run view: LEFT = the full status detail
    // (phase timeline + deploy terminal), RIGHT = a compact "activity" rail that
    // keeps the live status, a clean error, and the actions pinned in view.
    if (inProgress) {
      const queueTotal = queue?.length ?? 1;
      const runText = m.run as Record<string, string>;
      const runStatus = run?.status ?? "queued";
      const awaiting = runStatus === "awaiting_cutover";
      const partial = runStatus === "partial";
      // A run opened from the list can already be terminal-success; treat that
      // as done so the rail shows the result, not a spinner.
      const done = allDone || runStatus === "succeeded";
      const running = !failed && !done && !awaiting && !partial;
      const terminal = failed || runStatus === "succeeded"; // deletable record
      const railLabel = done
        ? queueTotal > 1
          ? interpolate(m.run.allSucceeded, { n: String(queueTotal) })
          : m.run.succeeded
        : awaiting
          ? m.run.awaiting_cutover
          : partial
            ? m.run.partial
            : runText[runStatus] ?? m.run.queued;

      return (
        <div ref={stepTopRef} className="grid grid-cols-1 gap-6 items-start lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            <div className="rounded-2xl border border-border/50 bg-card p-6">
              <MigrationProgress
                run={run}
                error={error}
                queueName={queue?.[queueIndex]?.name ?? ""}
                queueIndex={queueIndex}
                queueTotal={queueTotal}
                completed={completed}
                deployServices={deploy?.services}
                hasDomains={anyDomainAssigned}
                progress={progress}
              />
            </div>
            {/* Partial run → resolve the paths that didn't move (edit / skip),
                then Resume to finish. Lives in the wide LEFT column. */}
            {partial && migrationId && (
              <PartialResolution
                runId={migrationId}
                pending={(run?.pendingItems ?? []) as PendingItem[]}
              />
            )}
          </div>

          <div className="rounded-2xl border border-border/50 bg-card p-5 space-y-4 lg:sticky lg:top-4">
            {backBtn && <div className="flex">{backBtn}</div>}
            <div className="flex flex-col items-center gap-3 text-center">
              <span
                className={`inline-flex size-12 items-center justify-center rounded-2xl ${
                  failed
                    ? "bg-destructive/10 text-destructive"
                    : done || awaiting
                      ? "bg-success-bg text-success"
                      : partial
                        ? "bg-warning-bg text-warning"
                        : "bg-primary/10 text-primary"
                }`}
              >
                {failed ? (
                  <AlertCircle className="size-6" />
                ) : done || awaiting ? (
                  <CheckCircle2 className="size-6" />
                ) : partial ? (
                  <AlertCircle className="size-6" />
                ) : (
                  <Loader2 className="size-6 animate-spin" />
                )}
              </span>
              <div className="space-y-0.5">
                <p className="text-sm font-semibold text-foreground">{railLabel}</p>
                {queueTotal > 1 && running && (
                  <p className="text-xs text-muted-foreground">
                    {interpolate(m.run.queueHeader, {
                      index: String(queueIndex + 1),
                      total: String(queueTotal),
                      name: queue?.[queueIndex]?.name ?? "",
                    })}
                  </p>
                )}
              </div>
            </div>

            {/* The error text already shows in the LEFT card's failure banner
                (above the session log) — don't duplicate it here in the rail. */}
            {awaiting && (
              <p className="text-xs leading-relaxed text-muted-foreground">{m.cutover.warning}</p>
            )}

            <div className="space-y-2">
              {awaiting ? (
                <>
                  <button type="button" onClick={() => handleCutover(true)} disabled={cutoverBusy} className="inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition-colors disabled:opacity-40">{cutoverBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{m.cutover.stopRemove}</button>
                  <button type="button" onClick={() => handleCutover(false)} disabled={cutoverBusy} className="w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-40">{m.cutover.keep}</button>
                </>
              ) : partial ? (
                // Resolve UI (edit/skip + Resume) is in the wide LEFT column.
                <p className="text-xs leading-relaxed text-muted-foreground">{m.tab.pendingTitle} →</p>
              ) : done ? (
                <>
                  {!anyDomainAssigned && (
                    <button type="button" onClick={openDomains} className="inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"><ArrowRight className="size-4" />{m.run.addDomains}</button>
                  )}
                  <button type="button" onClick={openProject} className={anyDomainAssigned ? "inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors" : "w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"}>{anyDomainAssigned && <ArrowRight className="size-4" />}{m.run.openProject}</button>
                  <button type="button" onClick={close} className="w-full px-4 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">{m.wizard.close}</button>
                </>
              ) : (
                <>
                  {failed && run?.deploymentId && (
                    <button type="button" onClick={openDeployLogs} className="w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">{m.run.viewDeployLogs}</button>
                  )}
                  {failed && run?.inputSnapshot && (
                    <button type="button" onClick={editRetry} className="inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"><RefreshCw className="size-4" />{m.tab.editRetry}</button>
                  )}
                  {failed && (run?.targetVolumes?.length ?? 0) > 0 && (
                    <button type="button" onClick={() => void cleanupTarget()} disabled={cleanupBusy} className="inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-danger-border text-sm font-medium text-danger hover:bg-danger-bg transition-colors disabled:opacity-40">{cleanupBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{m.tab.cleanupTarget}</button>
                  )}
                  <button type="button" onClick={cancelRun} className="w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">{failed ? m.wizard.close : m.wizard.cancel}</button>
                </>
              )}
            </div>

            {/* Delete this run's record (terminal only; project + data untouched). */}
            {terminal && (
              <div className="border-t border-border/50 pt-3">
                {confirmingDelete ? (
                  <div className="space-y-2">
                    <p className="text-xs leading-relaxed text-muted-foreground">{m.tab.confirmDelete}</p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setConfirmingDelete(false)} disabled={deleteBusy} className="flex-1 px-3 py-2 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-40">{m.tab.close}</button>
                      <button type="button" onClick={() => void deleteRun()} disabled={deleteBusy} className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition-colors disabled:opacity-40">{deleteBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{m.tab.delete}</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => setConfirmingDelete(true)} className="inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-danger-border text-sm font-medium text-danger hover:bg-danger-bg transition-colors"><Trash2 className="size-4" />{m.tab.delete}</button>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }

    // Steps 2 (Source) & 3 (Configure) → focused FULL-WIDTH layout. You already
    // picked containers on step 1, so drop the list and give the mapping/config
    // the whole width as a responsive grid.
    if (adoptable && stack && active && step !== "select") {
      const picked = stack.services.filter((sv) => active.services.has(svcUid(sv)));

      // Target-server + move-options card (shared into the Configure right rail).
      const targetCard = (
        <div className="rounded-2xl border border-border/50 bg-card p-4 space-y-2.5">
          <div className="flex items-center gap-2">
            <ArrowRight className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">{m.wizard.targetLabel}</span>
          </div>
          <ServerSelector value={targetId} onSelect={(s) => setTargetId(s?.id ?? null)} compact />
          <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
            <input type="checkbox" checked={killOriginals} onChange={(e) => setKillOriginals(e.target.checked)} className="size-4 rounded border-border" />
            {m.wizard.killOriginals}
          </label>
          <span className={`block text-xs ${sameServer ? "text-muted-foreground" : "text-warning"}`}>{sameServer ? m.wizard.sameServer : m.run.downtimeNote}</span>
          {crossServerBuiltInfo && <span className="block text-xs text-muted-foreground">{m.wizard.crossServerBuiltInfo}</span>}
        </div>
      );

      return (
        <div ref={stepTopRef} className="space-y-5">
          {step === "source" ? (
            /* Source — repo picker inline (like Library) on the left, selected
               repo + actions in the right rail; once linked, the left becomes
               the container↔service mapping. No modal. */
            <div className="grid grid-cols-1 gap-6 items-start lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0">
                {active.repo ? (
                  <ServiceMapPanel
                    project={active}
                    stack={stack}
                    parsing={parsingRepo === active.id}
                    onSetMap={(uid, name) => setServiceMap(active.id, uid, name)}
                  />
                ) : github.connected ? (
                  <div className="rounded-2xl border border-border/50 bg-card p-4">
                    <RepositoryList
                      repos={github.repos}
                      accounts={github.accounts}
                      selectedOwner={github.selectedOwner}
                      setSelectedOwner={github.setSelectedOwner}
                      loading={github.loading}
                      loadingRepos={github.loadingRepos}
                      onSelect={(owner, r) =>
                        void onRepoChange(active.id, {
                          provider: "github",
                          owner,
                          repo: r.name,
                          branch: r.default_branch || "main",
                        })
                      }
                      installUrl={github.installUrl}
                    />
                  </div>
                ) : (
                  <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-border/50 bg-card p-8 text-center">
                    <p className="max-w-xs text-sm text-muted-foreground">{m.wizard.steps.repoConnectHint}</p>
                  </div>
                )}
              </div>
              <div className="lg:sticky lg:top-6 space-y-4">
                <RepoSourceCard
                  project={active}
                  github={github}
                  parsing={parsingRepo === active.id}
                  onRepoChange={(repo) => void onRepoChange(active.id, repo)}
                />
                <p className="px-0.5 text-[13px] leading-relaxed text-muted-foreground">{m.wizard.steps.mapSkipHint}</p>
                <div className="flex items-center justify-between gap-3">
                  <button type="button" onClick={() => setStep("select")} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                    <ArrowLeft className="size-4" />
                    {m.wizard.steps.back}
                  </button>
                  <button type="button" onClick={() => setStep("domains")} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
                    {m.wizard.steps.next}
                    <ArrowRight className="size-4" />
                  </button>
                </div>
              </div>
            </div>
          ) : step === "domains" ? (
            /* Configure — 2-grid of service cards on the left (like Select), the
               target card + finalize button reused in the right rail. */
            <div className="grid grid-cols-1 gap-6 items-start lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="grid min-w-0 grid-cols-1 gap-3.5 items-stretch xl:grid-cols-2">
                {buildPlanCards(active, stack.services).map(({ uid, service, isNew, action }) => (
                  <ServiceConfigCard
                    key={uid}
                    service={service}
                    sourceServerId={selectedId}
                    isNew={isNew}
                    deployAction={action}
                    routes={active.serviceRoutes[uid]}
                    envOverride={active.serviceEnvs[uid]}
                    sameServer={sameServer}
                    volumeStrategy={volumeStrategy[uid]}
                    routeMode={active.serviceRouteMode[uid] ?? (hasKeepableRoute(service) ? "keep" : "none")}
                    onSetRoutes={(r) => setServiceRoutes(active.id, uid, r)}
                    onSetEnv={(env) => setServiceEnv(active.id, uid, env)}
                    onSetStrategy={(strat) => setVolumeStrategy((prev) => ({ ...prev, [uid]: strat }))}
                    onSetRouteMode={(mode) => setServiceRouteMode(active.id, uid, mode)}
                  />
                ))}
              </div>
              <div className="lg:sticky lg:top-6 space-y-4">
                {targetCard}
                <div className="flex items-center justify-between gap-3">
                  <button type="button" onClick={() => setStep("source")} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                    <ArrowLeft className="size-4" />
                    {m.wizard.steps.back}
                  </button>
                  {sameServer ? (
                    <button type="button" onClick={handleMigrate} disabled={!canMigrate} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                      {starting ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                      {migratable.length > 1 ? interpolate(m.wizard.migrateN, { n: String(migratable.length) }) : m.wizard.migrate}
                    </button>
                  ) : (
                    <button type="button" onClick={() => setStep("plan")} disabled={!canMigrate} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                      {m.wizard.steps.next}
                      <ArrowRight className="size-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : null}
          {step === "plan" && (
            /* Transfer plan — the details get the main column; target + actions
               stay in the right rail (cross-server only). */
            <div className="grid grid-cols-1 gap-6 items-start lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0">
                <TransferPlanSummary
                  sourceId={selectedId}
                  targetId={targetId}
                  serviceNames={planServiceNames}
                  transferMode={transferMode}
                  setTransferMode={setTransferMode}
                  compress={compress}
                  setCompress={setCompress}
                  customPaths={customPaths}
                  setCustomPaths={setCustomPaths}
                  conflictResolution={conflictResolution}
                  setConflictResolution={setConflictResolution}
                  cache={planCacheRef}
                  onReady={setPlanReady}
                />
              </div>
              <div className="lg:sticky lg:top-6 space-y-4">
                {targetCard}
                <div className="flex items-center justify-between gap-3">
                  <button type="button" onClick={() => setStep("domains")} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                    <ArrowLeft className="size-4" />
                    {m.wizard.steps.back}
                  </button>
                  <button type="button" onClick={handleMigrate} disabled={!canMigrate || !planReady} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                    {starting ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                    {migratable.length > 1 ? interpolate(m.wizard.migrateN, { n: String(migratable.length) }) : m.wizard.migrate}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    return (
      <div ref={stepTopRef} className="grid grid-cols-1 gap-6 items-start lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ── LEFT: discovered containers ── */}
        <div className="min-w-0 space-y-4">
          {/* "← Back to migrations" leaves the flow; the rescan is a control of
              it, but they share this one line so the page doesn't spend two rows
              on chrome.

              The project tabs + "Add project" that used to own the row below are
              deliberately NOT rendered here for now. Multi-project splitting is
              still fully wired — projects / activeId / addProject / removeProject
              state, exclusive `claimedBy` assignment, and the modal variant that
              still renders the tabs — so bringing this back is a JSX-only change.
              `active` falls back to projects[0], which the scan always creates,
              so the single-project path works untouched. */}
          {backBtn && <div className="flex items-center gap-3">{backBtn}</div>}

          {!stack && !error && <EmptyHint scanning={scanning} status={scanStatus} />}
          {stack && !adoptable && !hasReimport && <NoResults message={m.discover.nothing} />}
          {stack && hasReimport && (
            <OpenshipReimportSection
              serverId={selectedId ?? ""}
              orphaned={orphanedOpenship}
              alreadyManaged={stack.alreadyManaged}
              onOpen={(pid) => router.push(`/projects/${pid}`)}
            />
          )}
          {adoptable && stack && active && (
            <div className="space-y-4">
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
                  readOnly={step !== "select"}
                />
              ))}
            </div>
          )}
          {error && !stack && <NoResults message={error} isError />}
        </div>

        {/* ── RIGHT: connection → stepped config → progress ── */}
        <div className="lg:sticky lg:top-6 space-y-4">
          {inProgress ? (
            <div className="rounded-2xl border border-border/50 bg-card p-5 space-y-4">
              <MigrationProgress
                run={run}
                error={error}
                queueName={queue?.[queueIndex]?.name ?? ""}
                queueIndex={queueIndex}
                queueTotal={queue?.length ?? 1}
                completed={completed}
                deployServices={deploy?.services}
                hasDomains={anyDomainAssigned}
                progress={progress}
              />
              <div className="flex flex-wrap items-center justify-end gap-2">
                {run?.status === "awaiting_cutover" ? (
                  <>
                    <button type="button" onClick={() => handleCutover(false)} disabled={cutoverBusy}
                      className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-40">
                      {m.cutover.keep}
                    </button>
                    <button type="button" onClick={() => handleCutover(true)} disabled={cutoverBusy}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition-colors disabled:opacity-40">
                      {cutoverBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      {m.cutover.stopRemove}
                    </button>
                  </>
                ) : allDone ? (
                  <>
                    <button type="button" onClick={close}
                      className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                      {m.wizard.close}
                    </button>
                    <button type="button" onClick={openProject}
                      className={anyDomainAssigned
                        ? "inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
                        : "px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"}>
                      {anyDomainAssigned && <ArrowRight className="size-4" />}
                      {m.run.openProject}
                    </button>
                    {!anyDomainAssigned && (
                      <button type="button" onClick={openDomains}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
                        <ArrowRight className="size-4" />
                        {m.run.addDomains}
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    {failed && run?.deploymentId && (
                      <button type="button" onClick={openDeployLogs}
                        className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                        {m.run.viewDeployLogs}
                      </button>
                    )}
                    <button type="button" onClick={cancelRun}
                      className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                      {failed ? m.wizard.close : m.wizard.cancel}
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : adoptable && stack && active ? (
            <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
              <div className="p-5 space-y-4">
                {step === "select" && (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-[13px] font-medium text-muted-foreground">{m.wizard.projectName}</label>
                      <input
                        value={active.name}
                        onChange={(e) => renameProject(active.id, e.target.value)}
                        placeholder={m.wizard.projectNamePlaceholder}
                        className="w-full px-3.5 py-2.5 rounded-xl bg-card border border-border text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
                      />
                    </div>
                    {/* Repo linking moved to the Source step (its own inline picker).
                        Keep Select focused on picking containers + naming. */}
                    <p className="rounded-xl border border-border/50 bg-muted/10 px-3.5 py-3 text-[13px] leading-relaxed text-muted-foreground">
                      {m.wizard.steps.repoOnSourceHint}
                    </p>
                    {/* Still reachable after a scan (flipping it re-scans) without
                        putting a control back in the list header. */}
                    {flatOption(false)}
                  </>
                )}

                {step === "source" && (
                  <ServiceMapPanel
                    project={active}
                    stack={stack}
                    parsing={parsingRepo === active.id}
                    onSetMap={(uid, name) => setServiceMap(active.id, uid, name)}
                  />
                )}

                {step === "domains" && (
                  <div className="space-y-4">
                    {buildPlanCards(active, stack.services).map(({ uid, service, isNew, action }) => (
                      <ServiceConfigCard
                        key={uid}
                        service={service}
                        sourceServerId={selectedId}
                        isNew={isNew}
                        deployAction={action}
                        routes={active.serviceRoutes[uid]}
                        envOverride={active.serviceEnvs[uid]}
                        sameServer={sameServer}
                        volumeStrategy={volumeStrategy[uid]}
                        routeMode={active.serviceRouteMode[uid] ?? (hasKeepableRoute(service) ? "keep" : "none")}
                        onSetRoutes={(r) => setServiceRoutes(active.id, uid, r)}
                        onSetEnv={(env) => setServiceEnv(active.id, uid, env)}
                        onSetStrategy={(strat) => setVolumeStrategy((prev) => ({ ...prev, [uid]: strat }))}
                        onSetRouteMode={(mode) => setServiceRouteMode(active.id, uid, mode)}
                      />
                    ))}

                    {/* Target + move options */}
                    <div className="rounded-xl border border-border/50 bg-muted/20 p-3 space-y-2.5">
                      <div className="flex items-center gap-2">
                        <ArrowRight className="size-4 text-muted-foreground" />
                        <span className="text-sm font-medium text-foreground">{m.wizard.targetLabel}</span>
                      </div>
                      <ServerSelector value={targetId} onSelect={(s) => setTargetId(s?.id ?? null)} compact />
                      <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                        <input type="checkbox" checked={killOriginals} onChange={(e) => setKillOriginals(e.target.checked)} className="size-4 rounded border-border" />
                        {m.wizard.killOriginals}
                      </label>
                      <span className={`block text-xs ${sameServer ? "text-muted-foreground" : "text-warning"}`}>
                        {sameServer ? m.wizard.sameServer : m.run.downtimeNote}
                      </span>
                      {crossServerBuiltInfo && <span className="block text-xs text-muted-foreground">{m.wizard.crossServerBuiltInfo}</span>}
                    </div>
                  </div>
                )}

                {step === "plan" && (
                  <TransferPlanSummary
                    sourceId={selectedId}
                    targetId={targetId}
                    serviceNames={planServiceNames}
                    transferMode={transferMode}
                    setTransferMode={setTransferMode}
                    compress={compress}
                    setCompress={setCompress}
                    customPaths={customPaths}
                    setCustomPaths={setCustomPaths}
                    conflictResolution={conflictResolution}
                    setConflictResolution={setConflictResolution}
                    cache={planCacheRef}
                    onReady={setPlanReady}
                  />
                )}
              </div>

              {/* Step footer */}
              <div className="px-5 py-4 border-t border-border/50 flex items-center justify-between gap-3">
                {step === "select" ? (
                  <>
                    <button type="button" onClick={close}
                      className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                      {m.wizard.cancel}
                    </button>
                    {rescanBtn}
                    <button type="button" onClick={() => setStep("source")} disabled={migratable.length === 0}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                      {m.wizard.steps.next}
                      <ArrowRight className="size-4" />
                    </button>
                  </>
                ) : step === "source" ? (
                  <>
                    <button type="button" onClick={() => setStep("select")}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                      <ArrowLeft className="size-4" />
                      {m.wizard.steps.back}
                    </button>
                    <button type="button" onClick={() => setStep("domains")}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
                      {m.wizard.steps.next}
                      <ArrowRight className="size-4" />
                    </button>
                  </>
                ) : step === "domains" ? (
                  <>
                    <button type="button" onClick={() => setStep("source")}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                      <ArrowLeft className="size-4" />
                      {m.wizard.steps.back}
                    </button>
                    {sameServer ? (
                      <button type="button" onClick={handleMigrate} disabled={!canMigrate}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                        {starting ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                        {migratable.length > 1 ? interpolate(m.wizard.migrateN, { n: String(migratable.length) }) : m.wizard.migrate}
                      </button>
                    ) : (
                      <button type="button" onClick={() => setStep("plan")} disabled={!canMigrate}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                        {m.wizard.steps.next}
                        <ArrowRight className="size-4" />
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => setStep("domains")}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                      <ArrowLeft className="size-4" />
                      {m.wizard.steps.back}
                    </button>
                    <button type="button" onClick={handleMigrate} disabled={!canMigrate || !planReady}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                      {starting ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                      {migratable.length > 1 ? interpolate(m.wizard.migrateN, { n: String(migratable.length) }) : m.wizard.migrate}
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            /* No host/connection card here — only the scan card. */
            <div className="rounded-2xl border border-border/50 bg-card p-5 space-y-3.5">
              <div className="flex items-center gap-2.5">
                <div className="size-9 rounded-xl bg-info/10 flex items-center justify-center shrink-0">
                  <Boxes className="size-[18px] text-info" />
                </div>
                <h3 className="text-sm font-semibold text-foreground leading-tight">{m.entry.cardTitle}</h3>
              </div>
              <p className="text-[13px] leading-relaxed text-muted-foreground">{m.entry.cardDesc}</p>
              {/* Scan-mode option sits directly above the button it changes. */}
              {flatOption(true)}
              <button
                type="button"
                onClick={() => handleScan()}
                disabled={!selectedId || scanning}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {scanning ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                {scanning ? m.wizard.scanning : m.wizard.scan}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <Modal
      isOpen={isOpen ?? false}
      onClose={close}
      width={wide ? "1600px" : "560px"}
      maxWidth="95vw"
      maxHeight={wide ? "95vh" : "86vh"}
      overflow="hidden"
      showCloseButton={false}
    >
      <div className={`flex flex-col ${wide ? "h-[95vh]" : "max-h-[86vh]"}`}>
        {modalHeader}
        {body}
      </div>
    </Modal>
  );
}

function EmptyHint({ scanning, status }: { scanning?: boolean; status?: string }) {
  const { t } = useI18n();
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex flex-col items-center px-6 pb-12 pt-10 text-center">
        {/* The migration illustration — the same one the runs-list empty state
            uses. Pulses during the scan so the body never goes blank. */}
        <MigrationIllustration className={`relative mb-7 h-32 w-72 max-w-full ${scanning ? "animate-pulse" : ""}`} />
        <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
          {scanning ? (status || t.migration.wizard.scanning) : t.migration.wizard.intro}
        </p>
      </div>
      {/* Safety guarantee footer — migration COPIES, never moves; nothing is
          deleted unless you explicitly cut over. */}
      <div className="flex items-start gap-2.5 border-t border-border/50 bg-muted/30 px-5 py-4 text-start">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">{t.migration.tab.safetyTitle}</span>{" "}
          {t.migration.tab.safetyBody}
        </p>
      </div>
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

/** Short, locale-aware "last deployed" date for the recovery cards. Guards a
 *  malformed manifest timestamp (returns it verbatim rather than "Invalid Date"). */
function formatSeen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Openship projects recovered from the server (matched by the `openship.project`
 * label + the on-server manifest) that this instance doesn't know — DB reset
 * (DR) or a server from another instance. Re-import rebuilds the project records
 * PRESERVING the original id so the running containers re-attach; it's records
 * only (no move/redeploy), so a "redeploy to finalize" note follows.
 */
export function OpenshipReimportSection({
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
  const disc = t.migration.discover; // reuse the shared running/stopped labels
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
    <section className="space-y-4">
      {/* Header — same shape as ServiceGroup (icon + title + muted count pill). */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 px-0.5">
          <Boxes className="size-4 text-muted-foreground shrink-0" />
          <h3 className="text-sm font-semibold text-foreground">{m.title}</h3>
          <span className="text-xs font-medium px-1.5 py-0.5 rounded-md bg-muted/70 text-muted-foreground shrink-0">
            {orphaned.length}
          </span>
        </div>
        <p className="max-w-2xl px-0.5 text-[13px] leading-relaxed text-muted-foreground">{m.intro}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 items-stretch">
        {orphaned.map((p) => {
          const doneId = done[p.projectId];
          const err = errors[p.projectId];
          const running = p.services.some((s) => s.running);
          const svcNames = p.services.map((s) => s.name).join(", ");
          return (
            <div
              key={p.projectId}
              className="flex h-full flex-col gap-3.5 rounded-2xl border border-border/50 bg-card p-5"
            >
              {doneId ? (
                <div className="flex h-full flex-col justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-success">
                    <CheckCircle2 className="size-4 shrink-0" />
                    {m.reimported}
                  </span>
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
                    className="w-full rounded-lg border border-border/60 bg-transparent px-2.5 py-1.5 text-sm font-medium text-foreground outline-none transition-colors focus:border-foreground/40"
                    placeholder={p.suggestedName}
                  />
                  {/* Identity: service names + quiet running/stopped status (same
                      treatment as ServiceRow), then domains + last-deployed. */}
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                        {svcNames || interpolate(m.services, { n: String(p.services.length) })}
                      </span>
                      <span
                        className={`shrink-0 text-[11px] font-medium uppercase tracking-wide ${
                          running ? "text-success" : "text-warning"
                        }`}
                      >
                        {running ? disc.running : disc.stopped}
                      </span>
                    </div>
                    {p.domains && p.domains.length > 0 && (
                      <div className="truncate text-[13px] text-muted-foreground">{p.domains.join(", ")}</div>
                    )}
                    <div className="flex items-center gap-2 text-[13px] text-muted-foreground/80">
                      <span>{p.hasSnapshot ? m.fullRestore : m.bestEffort}</span>
                      {p.updatedAt && <span>· {interpolate(m.lastSeen, { when: formatSeen(p.updatedAt) })}</span>}
                    </div>
                  </div>
                  {err && (
                    <p className="flex items-center gap-1.5 text-xs text-warning">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      {err}
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={busy === p.projectId || !serverId}
                    onClick={() => reimport(p)}
                    className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
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

      <p className="max-w-2xl px-0.5 text-xs leading-relaxed text-muted-foreground/70">
        {alreadyManaged > 0 && `${interpolate(m.alreadyManaged, { n: String(alreadyManaged) })} `}
        {m.finalizeNote}
      </p>
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
  readOnly = false,
}: {
  group: DiscoveredGroup;
  activeProject: ImportProject;
  claimedBy: Map<string, string>;
  projectsById: ImportProject[];
  onToggle: (svc: DiscoveredService) => void;
  onToggleGroup: () => void;
  groupLabel: (key: string | null) => string;
  /** Steps 2/3 render the list as an inert reference — no selecting. */
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const m = t.migration.discover;
  const isCompose = group.project !== null;
  const key = group.project ?? "__standalone__";

  // Free select — every group is bindable into the active project (no
  // one-compose-per-project restriction; no "add a separate project" gating).
  const bindable = true;
  const selectable = group.services.filter(
    (s) => !isExcluded(s) && (claimedBy.get(svcUid(s)) ?? activeProject.id) === activeProject.id,
  );
  const allOn = selectable.length > 0 && selectable.every((s) => activeProject.services.has(svcUid(s)));

  const nameOf = (id: string) => projectsById.find((p) => p.id === id)?.name || "";

  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-3 px-0.5">
        {/* Name + one muted meta string. No glyph, no pill: the group's kind is
            already the same for every row here, so a badge per group is noise. */}
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {isCompose ? group.project : m.standaloneGroup}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {isCompose ? `${m.composeGroup} · ${group.services.length}` : `· ${group.services.length}`}
          </span>
        </div>
        {!readOnly && bindable && selectable.length > 0 && (
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
      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2 items-stretch">
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
              readOnly={readOnly}
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
  readOnly = false,
}: {
  service: DiscoveredService;
  checked: boolean;
  claimedIn: string | null;
  bindHint: string | null;
  onToggle: () => void;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const m = t.migration.discover;
  const blocked = isBlocked(service);
  const proxy = isProxy(service);
  // Truly not-selectable (dim). readOnly (steps 2/3) is inert but stays legible —
  // those rows are the ALREADY-selected services shown as reference.
  const interactionBlocked = blocked || proxy || Boolean(claimedIn) || Boolean(bindHint);
  const inert = readOnly || interactionBlocked;
  const envCount = Object.keys(service.env).length;
  const source = service.build ? `${m.build}: ${service.dockerfile ?? service.build}` : service.image;

  return (
    <label
      className={`group relative flex h-full items-start gap-3 rounded-2xl border px-4 py-3.5 transition-colors ${
        interactionBlocked
          ? "cursor-not-allowed border-border/50 bg-card/40 opacity-55"
          : readOnly
            ? "cursor-default border-success-border bg-success/[0.05]"
            : checked
              ? "cursor-pointer border-success-border bg-success/[0.05]"
              : "cursor-pointer border-border/50 bg-card hover:border-foreground/25 hover:bg-muted/20"
      }`}
    >
      <span
        className={`mt-0.5 size-4 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
          interactionBlocked
            ? "border-border bg-muted"
            : checked
              ? "bg-success-solid border-success-solid text-white"
              : "border-border bg-transparent group-hover:border-foreground/40"
        }`}
      >
        {checked && !interactionBlocked && <Check className="size-3" />}
      </span>
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={inert} className="sr-only" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground truncate">{service.name}</span>
          {service.ports.map((p, i) => (
            <span
              key={`${p}-${i}`}
              className="rounded bg-muted/60 px-1.5 py-0.5 text-xs text-muted-foreground"
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
          {source && <span className="max-w-full truncate text-muted-foreground/90">{source}</span>}
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

      {/* Quiet status MARK — a small hollow "holo" ring instead of the loud
          RUNNING/STOPPED text, so the card stays clean. Full label on hover. */}
      <span
        className={`mt-1 block size-2.5 shrink-0 rounded-full ring-2 ring-inset ${
          service.running ? "ring-success/70" : "ring-warning/70"
        }`}
        title={service.running ? m.running : m.stopped}
        aria-label={service.running ? m.running : m.stopped}
      />
    </label>
  );
}

/** Parse a GitHub repo reference. Delegates the URL forms (https/ssh, ±.git) to
 *  the shared `extractOwnerRepoFromUrl`; adds only the bare `owner/repo` case it
 *  doesn't cover. Returns null for anything else (v1 = GitHub only). */
function parseGitHubRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim();
  if (!s) return null;
  const fromUrl = extractOwnerRepoFromUrl(s);
  if (fromUrl) return fromUrl;
  // Bare "owner/repo" (no github.com / scheme) — not handled by the URL parser.
  if (!s.includes("://") && !s.includes("github.com")) {
    const bare = s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (bare) return { owner: bare[1]!, repo: bare[2]! };
  }
  return null;
}

/** The container port of a discovered service's first published port (the
 *  natural default when assigning it a public route). */
function firstContainerPort(svc: DiscoveredService): string {
  const p = svc.ports[0];
  if (!p) return "";
  const parts = p.split("/")[0]!.split(":");
  return parts[parts.length - 1] ?? "";
}

/** Step 2 left column — link ONE project-level repo (list picker OR URL) and
 *  pick a branch. `onRepoChange` (link / branch / unlink) triggers the parent to
 *  parse the repo's compose + auto-map. Records source only — migrate still
 *  reuses the running image. */
function RepoSourceCard({
  project,
  github,
  parsing,
  onRepoChange,
}: {
  project: ImportProject;
  github: ReturnType<typeof useGitHub>;
  parsing: boolean;
  onRepoChange: (repo: RepoLink | null) => void;
}) {
  const { t } = useI18n();
  const s = t.migration.wizard.steps;
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const repo = project.repo;

  useEffect(() => {
    if (!repo) {
      setBranches([]);
      return;
    }
    let on = true;
    githubApi
      .listBranches(repo.owner, repo.repo)
      .then((res) => {
        if (on) setBranches((res?.data ?? []).map((b) => b.name).filter(Boolean));
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [repo?.owner, repo?.repo]);

  const applyUrl = () => {
    const parsed = parseGitHubRepo(urlInput);
    if (!parsed) {
      setUrlError(s.repoUrlInvalid);
      return;
    }
    setUrlError(null);
    onRepoChange({ provider: "github", owner: parsed.owner, repo: parsed.repo, branch: "main" });
    setUrlInput("");
  };

  return (
    <section className="space-y-3 rounded-xl border border-border/50 p-4">
      <div className="flex items-center gap-2">
        <GitBranch className="size-4 text-muted-foreground" />
        <h4 className="text-sm font-semibold text-foreground">{s.linkRepo}</h4>
        <span className="text-[11px] text-muted-foreground">· {s.repoOptional}</span>
      </div>
      <p className="text-xs text-muted-foreground">{s.linkRepoDesc}</p>

      {!github.connected ? (
        <button
          type="button"
          onClick={() => void github.connect()}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
        >
          <Link2 className="size-4" />
          {s.connectGithub}
        </button>
      ) : !repo ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{s.repoPasteHint}</p>
          <div className="flex items-center gap-2">
            <input
              value={urlInput}
              onChange={(e) => {
                setUrlInput(e.target.value);
                setUrlError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyUrl();
              }}
              placeholder={s.repoUrlPlaceholder}
              className="flex-1 min-w-0 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
            />
            <button
              type="button"
              onClick={applyUrl}
              className="shrink-0 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              {s.repoUrlAdd}
            </button>
          </div>
          {urlError && <p className="text-xs text-danger">{urlError}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-card px-3 py-2">
            <span className="inline-flex min-w-0 items-center gap-2 truncate text-sm font-medium text-foreground">
              {parsing && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
              {repo.owner}/{repo.repo}
            </span>
            <button
              type="button"
              onClick={() => onRepoChange(null)}
              className="shrink-0 text-xs text-muted-foreground hover:text-destructive transition-colors"
            >
              {s.unlinkRepo}
            </button>
          </div>
          <div className="space-y-1.5">
            <label className="text-[13px] font-medium text-muted-foreground">{s.branch}</label>
            <CustomSelect
              value={repo.branch}
              onChange={(val) => onRepoChange({ ...repo, branch: val })}
              options={(branches.length ? branches : [repo.branch]).map((b) => ({
                value: b,
                label: b,
                icon: <GitBranch className="size-3.5" />,
              }))}
            />
          </div>
        </div>
      )}
    </section>
  );
}

/** Step 2 map panel — after a repo is linked, map each selected discovered
 *  container to a service in the repo's parsed compose. The matched service's
 *  build context becomes that container's source subpath (derived at migrate).
 *  No repo → a prompt; no compose file → a graceful note. */
function ServiceMapPanel({
  project,
  stack,
  parsing,
  onSetMap,
}: {
  project: ImportProject;
  stack: DiscoveredStack;
  parsing: boolean;
  onSetMap: (uid: string, composeName: string | null) => void;
}) {
  const { t } = useI18n();
  const s = t.migration.wizard.steps;
  const picked = stack.services.filter((sv) => project.services.has(svcUid(sv)));
  const composeNames = project.composeServices.map((c) => c.name);

  if (!project.repo) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="max-w-xs text-sm text-muted-foreground">{s.mapNoRepo}</p>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Boxes className="size-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold text-foreground">{s.mapTitle}</h4>
        </div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{s.mapHint}</p>
      </div>

      {parsing ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {s.parsingCompose}
        </div>
      ) : composeNames.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card px-4 py-3 text-[13px] text-muted-foreground">
          {s.noComposeFound}
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-border/50 bg-card p-4 space-y-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              {s.composeServicesTitle}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {project.composeServices.map((c) => (
                <span
                  key={c.name}
                  className="inline-flex items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1 text-xs text-foreground"
                >
                  {c.name}
                  {c.build ? (
                    <span className="text-[10px] text-muted-foreground">{c.build}</span>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
          {/* One card per selected container: name on top, full-width service
              dropdown below — readable, no cramped truncation. */}
          <div className="grid gap-3.5 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
            {picked.map((sv) => {
              const uid = svcUid(sv);
              const mapped = project.serviceMap[uid] ?? "";
              return (
                <div key={uid} className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <Container className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm font-medium text-foreground" title={sv.name}>
                        {sv.name}
                      </span>
                    </div>
                    {(sv.image || sv.build) && (
                      <p className="mt-1 truncate text-[11px] text-muted-foreground/80" title={sv.image || sv.build}>
                        {sv.image || `${t.migration.discover.build}: ${sv.build}`}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                        {s.mapField}
                      </label>
                      {Object.keys(sv.env).length > 0 && (
                        <span className="shrink-0 text-[11px] text-muted-foreground/70">
                          {interpolate(t.migration.discover.nEnv, {
                            n: String(Object.keys(sv.env).length),
                          })}
                        </span>
                      )}
                    </div>
                    <CustomSelect
                      value={mapped}
                      onChange={(val) => onSetMap(uid, val || null)}
                      placeholder={s.mapToService}
                      options={[
                        { value: "", label: s.notInRepo },
                        ...composeNames.map((n) => ({ value: n, label: n })),
                      ]}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** Step 3 per-service card — the SAME editors the deploy wizard's ServiceCard
 *  uses: `PublicEndpointsCard` for the domain + `EnvironmentVariables` (settings
 *  mode) for env. Domain empty = the service stays internal. Env defaults to the
 *  discovered container's env and only carries an override once edited. */
function ServiceConfigCard({
  service,
  sourceServerId,
  routes,
  envOverride,
  sameServer,
  volumeStrategy,
  routeMode,
  isNew = false,
  deployAction = "reuse",
  onSetRoutes,
  onSetEnv,
  onSetStrategy,
  onSetRouteMode,
}: {
  service: DiscoveredService;
  /** Source server the container lives on — used to reveal its real (masked) env.
   *  Null before a server is picked; repo-only `isNew` cards have no container. */
  sourceServerId: string | null;
  routes: PublicEndpoint[] | undefined;
  envOverride: Record<string, string> | undefined;
  sameServer: boolean;
  volumeStrategy: VolumeStrategy | undefined;
  routeMode: RouteMode;
  /** True when this card is a repo compose service with no running container —
   *  it deploys fresh from the repo (not adopted from a container). */
  isNew?: boolean;
  /** How the service is deployed — drives the badge/color. */
  deployAction?: DeployAction;
  onSetRoutes: (routes: PublicEndpoint[]) => void;
  onSetEnv: (env: Record<string, string>) => void;
  onSetStrategy: (strat: VolumeStrategy) => void;
  onSetRouteMode: (mode: RouteMode) => void;
}) {
  const { t } = useI18n();
  const s = t.migration.wizard.steps;
  const d = t.migration.discover;
  // Borrowed from the home status row: "1 issue"/"{n} issues" is already translated
  // in all 9 locales there, where a migration-namespace copy would be English-only
  // in the 5 locales that have no migration.json.
  const issueLabel =
    service.warnings.length === 1
      ? t.dashboard.home.oneIssue
      : interpolate(t.dashboard.home.manyIssues, { n: String(service.warnings.length) });
  const port = routes?.[0]?.port ?? firstContainerPort(service);
  const [envModalOpen, setEnvModalOpen] = useState(false);
  const [imageEnvOpen, setImageEnvOpen] = useState(false);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const existing = service.existingRoute;
  // Flat {domain, path} pairs the foreign proxy already serves for this service —
  // a path-fan-out vhost yields several (e.g. api.onvo.me `/`, api.onvo.me `/v3`).
  const keptRoutes = (existing ?? []).flatMap((r) =>
    r.domains.map((domain) => ({ domain, path: r.path })),
  );
  const keptDomain0 = keptRoutes[0]?.domain;
  const volumeNames = service.volumes
    .filter((v) => v.type === "volume" && v.source)
    .map((v) => v.source!);

  // Stable placeholder endpoint (ref, not a render memo) so the editor row's id
  // doesn't churn — mid-edit clicks stay put. Full list echoed back; domain-less
  // routes filtered only at payload/publish.
  const placeholderRef = useRef<PublicEndpoint | null>(null);
  if (!placeholderRef.current) placeholderRef.current = createPublicEndpoint({ port });
  const shownEndpoints = routes?.length ? routes : [placeholderRef.current];
  const applyEndpoints = (next: PublicEndpoint[]) => onSetRoutes(next);

  // Switch route mode; seed/coerce the editor endpoint's domainType for free/custom
  // (prefilling the detected domain when overriding a "keep").
  const selectMode = (mode: RouteMode) => {
    if (mode === "free" || mode === "custom") {
      const base = routes?.[0] ?? placeholderRef.current!;
      onSetRoutes([
        mode === "custom" && routeMode === "keep" && keptDomain0
          ? { ...base, domainType: "custom", customDomain: keptDomain0 }
          : { ...base, domainType: mode },
      ]);
    }
    onSetRouteMode(mode);
  };

  const modes: RouteMode[] = existing ? ["keep", "free", "custom", "none"] : ["free", "custom", "none"];
  const modeLabel: Record<RouteMode, string> = {
    keep: s.routeKeep,
    free: s.routeFree,
    custom: s.routeCustom,
    none: s.routeNone,
  };

  const envRecord = envOverride ?? service.env;
  const envRows = useMemo(() => envToRows(envRecord), [envRecord]);
  // On-demand reveal: the scan masks env, so the eye / "Show values" fetches the
  // real values for THIS container from the source server. Only wired when there's
  // a running container to read (repo-only `isNew` cards have no server-side env).
  const containerId = service.containerId;
  const onRevealAll = useMemo(() => {
    if (!sourceServerId || !containerId) return undefined;
    const serverId = sourceServerId;
    const cid = containerId;
    return () =>
      dockerMigrationApi.revealEnv({ serverId, containerId: cid }).then((r) => r.environment);
  }, [sourceServerId, containerId]);
  // Image-supplied vars not yet pinned as config — importing them adds them to the
  // override, which empties this list and bumps the env count.
  const pendingImageEnv = useMemo(
    () => Object.entries(service.envImageDefaults ?? {}).filter(([k]) => !(k in envRecord)),
    [service.envImageDefaults, envRecord],
  );

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Container className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground truncate">{service.name}</span>
        {service.ports.map((p, i) => (
          <span
            key={`${p}-${i}`}
            className="rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
          >
            {p}
          </span>
        ))}
        {/* Deploy action: reuse the mapped container's image (adopted), build from
            the repo, or pull a registry image. `New` marks a repo service with no
            running container — it deploys fresh from the repo, not adopted. */}
        <span className="ms-auto flex items-center gap-1.5">
          {/* Caveats collapse to a count here. Expanded by default they pushed a
              wall of yellow prose above every card's Route row, which read as
              "something is broken" on a stack where each bind mount is one line
              of expected detail. */}
          {service.warnings.length > 0 && (
            <button
              type="button"
              onClick={() => setWarningsOpen((v) => !v)}
              aria-expanded={warningsOpen}
              // Bordered so it reads as the one clickable thing in a row of
              // same-toned static badges (`New` is warning-coloured too).
              className="flex items-center gap-1 rounded-md border border-warning-border bg-warning-bg px-1.5 py-0.5 text-[10px] font-medium text-warning transition-opacity hover:opacity-80"
            >
              <AlertTriangle className="size-3 shrink-0" />
              {issueLabel}
              {warningsOpen ? (
                <ChevronDown className="size-3 shrink-0" />
              ) : (
                <ChevronRight className="size-3 shrink-0" />
              )}
            </button>
          )}
          {isNew && (
            <span className="rounded-md bg-warning-bg px-1.5 py-0.5 text-[10px] font-medium text-warning">
              {s.serviceNewBadge}
            </span>
          )}
          <span
            className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
              deployAction === "build"
                ? "bg-info-bg text-info"
                : "bg-muted/60 text-muted-foreground"
            }`}
          >
            {deployAction === "build"
              ? s.deployActionBuild
              : deployAction === "pull"
                ? s.deployActionPull
                : s.deployActionReuse}
          </span>
        </span>
      </div>

      {/* What discovery could not carry over: build-time vars, bind mounts, dropped ports */}
      {warningsOpen && service.warnings.length > 0 && (
        <div className="space-y-1 rounded-lg border border-warning-border bg-warning-bg px-3 py-2">
          {service.warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-1.5 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {warning}
            </p>
          ))}
        </div>
      )}

      {/* Route: Free / Custom / None (+ Keep when a route was already detected) */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Globe className="size-3.5 text-muted-foreground" />
          <span className="text-[13px] font-medium text-muted-foreground">{s.routeTitle}</span>
          {existing && existing.length > 0 && (
            <span
              className={`ms-auto rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                existing.some((r) => r.ssl.enabled) ? "bg-success-bg text-success" : "bg-muted/60 text-muted-foreground"
              }`}
            >
              {existing.some((r) => r.ssl.enabled) ? s.sslOn : s.sslOff}
            </span>
          )}
        </div>

        <div className="flex w-fit gap-0.5 rounded-lg border border-border/60 p-0.5 text-[11px] font-medium">
          {modes.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => selectMode(opt)}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                routeMode === opt
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {modeLabel[opt]}
            </button>
          ))}
        </div>

        {/* Route detail — only for modes that HAVE content. "None" renders
            nothing (an empty reserved box just left a big whitespace gap on
            no-domain services like a DB). A small min-height keeps the domain
            box + slug editor from jumping when switching Keep/Free/Custom. */}
        {routeMode !== "none" && (
          <div className="flex min-h-[3rem] flex-col justify-center">
            {routeMode === "keep" && keptRoutes.length > 0 && (
              <div className="space-y-1 rounded-lg border border-border/50 bg-card/40 px-3 py-2">
                {keptRoutes.map((r, i) => (
                  <div key={`${r.domain}${r.path}${i}`} className="flex items-center gap-1.5">
                    <a
                      href={`https://${r.domain}${r.path === "/" ? "" : r.path}`}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-sm text-foreground hover:text-primary transition-colors"
                    >
                      {r.domain}
                    </a>
                    {r.path !== "/" && (
                      <span className="rounded bg-muted px-1 py-px text-[11px] font-mono text-muted-foreground">
                        {r.path}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {(routeMode === "free" || routeMode === "custom") && (
              <PublicEndpointsCard
                projectName={service.name}
                endpoints={shownEndpoints}
                hasServer
                runtimePort={port}
                allowPortEdit
                saveMode="change"
                hideHeader
                hideTypeToggle
                portInline
                onChange={(next) => applyEndpoints(next)}
              />
            )}
          </div>
        )}
      </div>

      {volumeNames.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card/40 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">{d.volumesTitle}</p>
            <p className="truncate text-[11px] text-muted-foreground">{volumeNames.join(", ")}</p>
          </div>
          {sameServer ? (
            <div className="flex shrink-0 rounded-lg border border-border/60 p-0.5 text-[11px] font-medium">
              {(["reuse", "copy"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => onSetStrategy(opt)}
                  className={`rounded-md px-2.5 py-1 transition-colors ${
                    (volumeStrategy ?? "reuse") === opt
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt === "reuse" ? d.volumeReuse : d.volumeCopy}
                </button>
              ))}
            </div>
          ) : (
            <span className="shrink-0 text-[11px] text-muted-foreground">{d.volumeCopy}</span>
          )}
        </div>
      )}

      {/* Env vars open in the SAME modal the deploy wizard uses (ComposeServices)
          instead of an inline expander. */}
      <button
        type="button"
        onClick={() => setEnvModalOpen(true)}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 text-start transition-colors hover:bg-muted/30"
      >
        <span className="flex min-w-0 items-center gap-2">
          <KeyRound className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground">{s.envTitle}</span>
          <span className="text-[12px] text-muted-foreground/70">
            · {interpolate(d.nEnv, { n: String(Object.keys(envRecord).length) })}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {/* Env the IMAGE supplies, not the operator (recovered from Docker's
          create-time merge order). Deliberately muted, not a warning: nothing is
          lost — the same image re-supplies it — but it's one click to pin as
          explicit config, which is what you want before rebuilding from source. */}
      {pendingImageEnv.length > 0 && (
        <div className="rounded-lg border border-border/50 bg-muted/10 px-3 py-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setImageEnvOpen((v) => !v)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-start text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {imageEnvOpen ? (
                <ChevronDown className="size-3.5 shrink-0" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0" />
              )}
              <span className="truncate">
                {interpolate(d.envFromImage, { n: String(pendingImageEnv.length) })}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onSetEnv({ ...envRecord, ...Object.fromEntries(pendingImageEnv) })}
              className="shrink-0 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            >
              {d.envFromImageImport}
            </button>
          </div>
          {imageEnvOpen && (
            <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
              <p className="text-[11px] text-muted-foreground/70">{d.envFromImageHint}</p>
              {pendingImageEnv.map(([key, value]) => (
                <p key={key} className="truncate font-mono text-[11px] text-muted-foreground">
                  {key}={value}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

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
                <p className="truncate text-sm font-semibold text-foreground">{service.name}</p>
                <p className="text-xs text-muted-foreground">
                  {s.envTitle} · {interpolate(d.nEnv, { n: String(Object.keys(envRecord).length) })}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEnvModalOpen(false)}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              aria-label={s.envTitle}
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="max-h-[calc(86vh-92px)] overflow-y-auto">
          <EnvironmentVariables
            mode="settings"
            borderless
            envVars={envRows}
            onEnvVarsChange={(rows) => onSetEnv(rowsToEnv(rows))}
            onRevealAll={onRevealAll}
          />
        </div>
      </Modal>
    </div>
  );
}

/**
 * Cross-server transfer plan shown on the Configure step: scans the source and
 * renders the total payload size + per-volume/image/bind breakdown, plus the
 * transfer options (Direct vs Relay, Compress). This is the "how many GB +
 * details before you commit" step. Same-server renders nothing (nothing moves).
 */
function TransferPlanSummary({
  sourceId,
  targetId,
  serviceNames,
  transferMode,
  setTransferMode,
  compress,
  setCompress,
  customPaths,
  setCustomPaths,
  conflictResolution,
  setConflictResolution,
  cache,
  onReady,
}: {
  sourceId: string | null;
  targetId: string | null;
  serviceNames: string[];
  transferMode: TransferModeSel;
  setTransferMode: (v: TransferModeSel) => void;
  compress: boolean;
  setCompress: (v: boolean) => void;
  customPaths: CustomPath[];
  setCustomPaths: (v: CustomPath[]) => void;
  /** volumeName → conflict resolution (override/clone/keep), chosen here. */
  conflictResolution: Record<string, ConflictAction>;
  setConflictResolution: React.Dispatch<React.SetStateAction<Record<string, ConflictAction>>>;
  /** Preview cache (by request key) so Back/Next doesn't re-hit the server. */
  cache: { current: Map<string, MigrationPreview> };
  /** Fires true once the plan is loaded AND every volume conflict is resolved
   *  (both mandatory before Migrate); false while loading / on error / unresolved. */
  onReady?: (ready: boolean) => void;
}) {
  const { t } = useI18n();
  const m = t.migration;
  const plan = m.wizard.plan as Record<string, string>;

  // Re-size when the service set OR the custom paths change (each is a discrete
  // add/remove action, so no keystroke spam).
  const key = `${sourceId}|${targetId}|${[...serviceNames].sort().join(",")}|${customPaths
    .map((c) => `${c.source}>${c.dest}`)
    .join(",")}`;

  const [preview, setPreview] = useState<MigrationPreview | null>(() => cache.current.get(key) ?? null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newSrc, setNewSrc] = useState("");
  const [newDst, setNewDst] = useState("");

  useEffect(() => {
    if (!sourceId || !targetId || serviceNames.length === 0) return;
    const cached = cache.current.get(key);
    if (cached) {
      setPreview(cached);
      setErr(null);
      setLoading(false);
      return; // readiness handled by the effect below (factors conflicts)
    }
    let live = true;
    setLoading(true);
    setErr(null);
    onReady?.(false);
    dockerMigrationApi
      .preview({ sourceServerId: sourceId, targetServerId: targetId, serviceNames, customPaths })
      .then((res) => {
        if (!live) return;
        cache.current.set(key, res.preview);
        setPreview(res.preview);
      })
      .catch((e) => live && (setErr(getApiErrorMessage(e, m.scanFailed)), onReady?.(false)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Migrate is gated until the plan is loaded AND every conflicting service has
  // a resolution — so nothing destructive starts with an unresolved conflict.
  const conflicts = preview?.conflicts ?? [];
  useEffect(() => {
    if (!preview) return;
    onReady?.(conflicts.every((c) => Boolean(conflictResolution[c.volume])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, conflictResolution]);

  const addPath = () => {
    const source = newSrc.trim();
    const dest = newDst.trim();
    if (!source.startsWith("/") || !dest.startsWith("/")) return;
    setCustomPaths([...customPaths, { source, dest }]);
    setNewSrc("");
    setNewDst("");
  };

  const p = preview?.plan;
  const ssl = preview?.sslByDomain ?? [];
  const canAdd = newSrc.trim().startsWith("/") && newDst.trim().startsWith("/");
  const inputClass =
    "min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/25";
  return (
    <div className="space-y-5 rounded-2xl border border-border/50 bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-foreground">{plan.title}</span>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Target-volume conflicts — must be resolved (override/clone/keep) before
          Migrate. Keyed by the unique VOLUME name so two same-named services stay
          isolated. Gates onReady above; nothing destructive starts unresolved. */}
      {conflicts.length > 0 && (
        <div className="space-y-4 rounded-xl border border-warning-border bg-warning-bg/40 p-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4 shrink-0 text-warning" />
            <span className="text-sm font-medium text-foreground">{plan.conflictTitle}</span>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{plan.conflictDesc}</p>
          {conflicts.map((c) => {
            const sel = conflictResolution[c.volume];
            const opt = (action: ConflictAction, label: string, hint: string) => (
              <button
                key={action}
                type="button"
                onClick={() => setConflictResolution((prev) => ({ ...prev, [c.volume]: action }))}
                className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                  sel === action ? "border-primary bg-primary/10" : "border-border hover:bg-muted/40"
                }`}
              >
                <span className="block text-sm font-medium text-foreground">{label}</span>
                <span className="block text-xs leading-tight text-muted-foreground">{hint}</span>
              </button>
            );
            return (
              <div key={c.volume} className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-foreground">{c.serviceName}</span>
                  <span className="min-w-0 truncate text-muted-foreground" title={c.volume}>
                    {c.volume}
                  </span>
                </div>
                <div className="flex gap-2">
                  {opt("override", plan.conflictOverride, plan.conflictOverrideHint)}
                  {opt("clone", plan.conflictClone, plan.conflictCloneHint)}
                  {opt("keep", plan.conflictKeep, plan.conflictKeepHint)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {err ? (
        <p className="text-sm text-danger">{err}</p>
      ) : p ? (
        <div className="space-y-2.5">
          <p className="tabular-nums text-foreground">
            <span className="text-lg font-semibold">
              {p.partial ? "≥ " : ""}
              {formatBytes(p.totalBytes)}
            </span>
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">{plan.total}</span>
          </p>
          {p.items.length > 0 && (
            <ul className="max-h-56 space-y-1.5 overflow-auto">
              {p.items.map((it) => (
                <li
                  key={`${it.kind}:${it.ref}`}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                      {plan[it.kind] ?? it.kind}
                    </span>
                    {it.exists === false && <AlertCircle className="size-3.5 shrink-0 text-warning" />}
                    <span className="truncate text-muted-foreground" title={it.ref}>
                      {it.ref}
                    </span>
                  </span>
                  <span className={`shrink-0 tabular-nums ${it.exists === false ? "text-warning" : "text-foreground"}`}>
                    {it.exists === false
                      ? plan.missing
                      : it.bytes == null
                        ? plan.unknown
                        : formatBytes(it.bytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : loading ? (
        // Alive loading state — a shimmer skeleton + "measuring" line instead of
        // just a corner spinner, so the size scan (du over SSH) doesn't feel dead.
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {plan.measuring}
          </div>
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="h-4 w-12 shrink-0 animate-pulse rounded bg-muted" />
                  <div
                    className="h-4 animate-pulse rounded bg-muted"
                    style={{ width: `${55 - i * 12}%` }}
                  />
                </div>
                <div className="h-4 w-16 shrink-0 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{plan.empty}</p>
      )}

      {/* SSL checks — which kept domains carry their cert vs re-issue via ACME. */}
      {ssl.length > 0 && (
        <div className="space-y-2 border-t border-border/50 pt-4">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {plan.sslTitle}
          </span>
          {ssl.map((s) => (
            <div key={s.domain} className="flex items-center gap-2 text-sm">
              {s.hasCert ? (
                <Check className="size-4 shrink-0 text-success" />
              ) : (
                <span className="inline-block size-2 shrink-0 rounded-full bg-warning" />
              )}
              <span className="truncate text-foreground" title={s.domain}>
                {s.domain}
              </span>
              <span className={s.hasCert ? "text-success" : "text-warning"}>
                — {s.hasCert ? plan.sslReuse : plan.sslIssue}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Custom paths — arbitrary source → dest files/folders to move. */}
      <div className="space-y-2 border-t border-border/50 pt-4">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {plan.pathsTitle}
        </span>
        {customPaths.map((c, i) => (
          <div key={`${c.source}>${c.dest}`} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={`${c.source} → ${c.dest}`}>
              {c.source} <span className="text-muted-foreground/50">→</span> {c.dest}
            </span>
            <button
              type="button"
              onClick={() => setCustomPaths(customPaths.filter((_, j) => j !== i))}
              className="shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-danger"
              aria-label={plan.pathRemove}
            >
              ×
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input
            value={newSrc}
            onChange={(e) => setNewSrc(e.target.value)}
            placeholder={plan.pathSrcPlaceholder}
            className={inputClass}
          />
          <span className="shrink-0 text-muted-foreground/50">→</span>
          <input
            value={newDst}
            onChange={(e) => setNewDst(e.target.value)}
            placeholder={plan.pathDestPlaceholder}
            className={inputClass}
          />
          <button
            type="button"
            onClick={addPath}
            disabled={!canAdd}
            className="shrink-0 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {plan.pathAdd}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border/50 pt-4">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {m.wizard.transfer.label}
          <select
            value={transferMode}
            onChange={(e) => setTransferMode(e.target.value as TransferModeSel)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
          >
            <option value="">{m.wizard.transfer.default}</option>
            <option value="stream">{m.wizard.transfer.stream}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={compress}
            onChange={(e) => setCompress(e.target.checked)}
            className="size-4 rounded border-border/60 bg-card text-primary focus:ring-2 focus:ring-primary/30"
          />
          {plan.compress}
        </label>
      </div>
    </div>
  );
}

export function MigrationProgress({
  run,
  error,
  queueName,
  queueIndex,
  queueTotal,
  completed,
  deployServices,
  hasDomains,
  progress,
}: {
  run: MigrationRun | null;
  error: string | null;
  queueName: string;
  queueIndex: number;
  queueTotal: number;
  completed: Array<{ name: string; projectId?: string | null }>;
  deployServices?: Array<{ name: string; status: string; error?: string }>;
  /** True when at least one migrated service got a domain — suppresses the
   *  "not public yet, add a domain" hint (the stack is already reachable). */
  hasDomains?: boolean;
  /** Live data-move progress (bytes streamed) during moving_data. */
  progress?: TransferProgress | null;
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
    <div className="py-2 space-y-5 text-sm">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-foreground">{m.run.title}</h3>
        {queueTotal > 1 && !allDone && (
          <span className="text-sm font-medium text-muted-foreground">
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
          {!hasDomains && (
            <p className="px-1 text-xs leading-relaxed text-muted-foreground/80">{m.run.routeHint}</p>
          )}
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
                {p === "moving_data" && state === "active" && progress && progress.movedBytes > 0 && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {progress.totalBytes && progress.totalBytes > 0
                      ? ` · ${Math.min(100, Math.round((progress.movedBytes / progress.totalBytes) * 100))}%`
                      : ` · ${formatBytes(progress.movedBytes)}`}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {/* Live transfer bar — the byte-level progress of the data move. */}
      {status === "moving_data" && progress && progress.movedBytes > 0 && (
        <div className="space-y-1.5 rounded-xl border border-border/50 bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="truncate text-muted-foreground">
              {progress.kind === "image" ? m.run.movingImage : m.run.movingVolume}
            </span>
            <span className="shrink-0 tabular-nums text-foreground">
              {progress.totalBytes && progress.totalBytes > 0
                ? `${formatBytes(progress.movedBytes)} / ${formatBytes(progress.totalBytes)}`
                : formatBytes(progress.movedBytes)}
            </span>
          </div>
          {progress.totalBytes && progress.totalBytes > 0 ? (
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                style={{
                  width: `${Math.min(100, Math.round((progress.movedBytes / progress.totalBytes) * 100))}%`,
                }}
              />
            </div>
          ) : (
            // Unknown total (relay path) → indeterminate sweep.
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
            </div>
          )}
        </div>
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
                      <span className="text-foreground">{s.name}</span>
                      <span className="text-muted-foreground">{s.status}</span>
                      {s.error && <span className="min-w-0 flex-1 truncate text-danger">— {s.error}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {/* Native terminal — reuses the /deploy xterm (TerminalSurface +
                useBuildStream attach-only), driven by the run's deploymentId.
                Live while deploying/verifying, persisted logs on failure.
                The xterm mounts `absolute inset-0` inside a fixed-height box so
                its FitAddon can never drive the box taller than itself — without
                that decoupling the fit↔ResizeObserver loop grows the panel
                without bound in a content-sized (non-modal) layout. */}
            <div className="relative h-[360px] w-full overflow-hidden rounded-xl border border-border/50">
              <DeploymentTerminal
                deploymentId={run.deploymentId}
                live={status === "deploying" || status === "verifying"}
                className="absolute inset-0"
              />
            </div>
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

      {/* Durable orchestration log — the "what happened" for debugging, shown for
          any run with output (live or after the fact). */}
      {run?.logs && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{m.tab.sessionLog}</p>
          <div className="max-h-56 overflow-y-auto rounded-xl border border-border/50 bg-muted/20 px-4 py-3 font-mono text-[12px] leading-relaxed text-muted-foreground">
            {run.logs.split("\n").map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A `partial` run's resolution panel: the paths that didn't move, each with an
 * optional new-source override input + a skip toggle, and a Resume button. On
 * resume the run flips out of `partial` (→ moving_data) and the parent's poll
 * takes over showing progress; when everything's resolved it finishes normally.
 */
function PartialResolution({ runId, pending }: { runId: string; pending: PendingItem[] }) {
  const { t } = useI18n();
  const tab = t.migration.tab;
  const plan = t.migration.wizard.plan as Record<string, string>;
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  if (pending.length === 0) return null;

  const resume = async () => {
    setBusy(true);
    const cleanOverrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(overrides)) if (v.trim()) cleanOverrides[k] = v.trim();
    const skip = Object.keys(skipped).filter((k) => skipped[k]);
    try {
      await dockerMigrationApi.resume(runId, { overrides: cleanOverrides, skip });
      // Status flips server-side; the parent progress poll picks it up.
    } catch {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 rounded-2xl border border-border/50 bg-card p-5">
      <div className="flex items-center gap-2">
        <AlertCircle className="size-4 text-warning" />
        <h4 className="text-sm font-semibold text-foreground">{tab.pendingTitle}</h4>
      </div>
      <ul className="space-y-3">
        {pending.map((p) => {
          const isSkip = Boolean(skipped[p.key]);
          return (
            <li
              key={p.key}
              className={`space-y-2 rounded-xl border border-border/50 p-3 ${isSkip ? "opacity-50" : ""}`}
            >
              <div className="flex items-center gap-2 text-sm">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {plan[p.kind] ?? p.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground" title={p.source}>
                  {p.source}
                </span>
                <span className="shrink-0 text-[11px] text-warning">
                  {p.reason === "missing" ? tab.pendingMissing : tab.pendingError}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={overrides[p.key] ?? ""}
                  disabled={isSkip}
                  onChange={(e) => setOverrides((o) => ({ ...o, [p.key]: e.target.value }))}
                  placeholder={tab.overridePlaceholder}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/25 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setSkipped((s) => ({ ...s, [p.key]: !s[p.key] }))}
                  className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted"
                >
                  {isSkip ? tab.undoSkip : tab.skip}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => void resume()}
        disabled={busy}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        {busy ? tab.resuming : tab.resume}
      </button>
    </div>
  );
}
