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
  Layers,
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
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import {
  dockerMigrationApi,
  deployApi,
  githubApi,
  servicesApi,
  getApiErrorMessage,
  type DiscoveredStack,
  type DiscoveredGroup,
  type DiscoveredService,
  type ComposeRepoService,
  type OpenshipProjectGroup,
  type MigrationRun,
  type MigrationStatus,
} from "@/lib/api";
import { useGitHub } from "@/context/GitHubContext";
import { RepositoryList } from "@/app/(dashboard)/library/components/RepositoryList";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import { CustomSelect } from "@/components/ui/CustomSelect";
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

/** Stable key for a group — the compose project name, or the standalone sentinel. */
const STANDALONE = "__standalone__";
const groupKey = (g: DiscoveredGroup) => g.project ?? STANDALONE;

const RUN_PHASES: MigrationStatus[] = ["adopting", "moving_data", "deploying", "verifying"];

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
  /** serviceName → env override (sent to the migrate API). */
  serviceEnv?: Record<string, Record<string, string>>;
  /** serviceName → routes to apply AFTER the run verifies (client-only, NOT sent). */
  routesByServiceName?: Record<string, PublicEndpoint[]>;
}

const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

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
}: {
  isOpen?: boolean;
  onClose: () => void;
  serverId?: string;
  /** "modal" (Library, default) wraps in a Modal; "tab" renders an inline
   *  two-column layout for the server-detail Services tab (left = discovered
   *  containers, right = the connection card until a scan swaps in the config). */
  variant?: "modal" | "tab";
  /** Connection summary for the tab's right column before a scan (server detail). */
  server?: { sshHost: string; sshPort?: number | null; sshUser?: string | null; sshAuthMethod?: string | null } | null;
}) {
  const { t } = useI18n();
  const m = t.migration;
  const router = useRouter();
  const github = useGitHub();

  // Wizard step for the adopt/migrate flow: select services → link source →
  // domains/routes → migrate. Only gates the `adoptable && stack` screen; the
  // re-import, flat-docker, and progress branches are step-agnostic.
  const [step, setStep] = useState<"select" | "source" | "domains">("select");

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
  const [transferMode, setTransferMode] = useState<"" | "auto" | "stream" | "direct" | "rsync">("");

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
  // Per-service status peek (the failure rows). Full logs are shown by the
  // embedded DeploymentTerminal (its own build-session stream), not here.
  const [deploy, setDeploy] = useState<{
    services?: Array<{ name: string; status: string; error?: string }>;
  } | null>(null);
  const [cutoverBusy, setCutoverBusy] = useState(false);
  // Projects whose routes we've already applied — guards the completion effect
  // from re-firing on poll ticks.
  const publishedRef = useRef<Set<string>>(new Set());

  const reset = () => {
    setStep("select");
    publishedRef.current = new Set();
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
      const first = scanned.groups.find((g) => g.services.some((s) => !isExcluded(s)));
      if (first) {
        const uids = first.services.filter((s) => !isExcluded(s)).map(svcUid);
        const preselect = first.project ? uids : [];
        setProjects([
          {
            id: randomUUID(),
            name: first.project ?? serverName ?? "migrated-app",
            services: new Set(preselect),
            bound: groupKey(first),
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

  const nextProjectName = () => {
    const usedComposes = new Set(projects.map((p) => p.bound).filter(Boolean));
    const freeCompose = stack?.groups.find(
      (g) => g.project && !usedComposes.has(g.project),
    )?.project;
    if (freeCompose) return freeCompose;
    return `project-${projects.length + 1}`;
  };

  const addProject = () => {
    const p: ImportProject = {
      id: randomUUID(),
      name: nextProjectName(),
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
        gitSource: item.gitSource,
        serviceSubpaths: item.serviceSubpaths,
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
      const serviceEnv: Record<string, Record<string, string>> = {};
      const routesByServiceName: Record<string, PublicEndpoint[]> = {};
      for (const s of picked) {
        const mapped = p.serviceMap[svcUid(s)];
        const build = mapped ? composeByName.get(mapped)?.build?.trim() : undefined;
        if (build) serviceSubpaths[s.name] = build;
        const env = p.serviceEnvs[svcUid(s)];
        if (env) serviceEnv[s.name] = env; // only edited services carry an override
        // Resolve the route by the per-container mode. "keep" reuses the domain
        // the foreign proxy already served; free/custom take the editor value
        // (domain-less placeholders filtered here, not mid-edit); none → skip.
        const uid = svcUid(s);
        const mode: RouteMode = p.serviceRouteMode[uid] ?? (s.existingRoute?.domains.length ? "keep" : "none");
        let routes: PublicEndpoint[] = [];
        if (mode === "keep" && s.existingRoute?.domains.length) {
          routes = [
            createPublicEndpoint({
              port: firstContainerPort(s),
              domainType: "custom",
              customDomain: s.existingRoute.domains[0],
            }),
          ];
        } else if (mode === "free" || mode === "custom") {
          routes = (p.serviceRoutes[uid] ?? []).filter(routeHasDomain);
        }
        if (routes.length) routesByServiceName[s.name] = routes;
      }
      return {
        name: p.name.trim(),
        serviceNames: picked.map((s) => s.name),
        volumeStrategies,
        gitSource: p.repo
          ? { provider: "github" as const, owner: p.repo.owner, repo: p.repo.repo, branch: p.repo.branch }
          : undefined,
        serviceSubpaths: Object.keys(serviceSubpaths).length ? serviceSubpaths : undefined,
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
    // Record the chosen routes on the just-verified project (reload-free, no
    // redeploy) so kept/added domains land on its Domains tab automatically.
    const doneRoutes = queue[queueIndex]?.routesByServiceName;
    if (run.projectId && doneRoutes && Object.keys(doneRoutes).length > 0) {
      void applyRoutes(run.projectId, doneRoutes);
    }
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

  // Record the routes chosen in the wizard onto the migrated project the moment
  // it verifies — RELOAD-FREE (expose the service + set its domain; the backend's
  // updateService applies the edge vhost to the live container IP via
  // reconcileProjectRoutes, so NO redeploy and NO container recreation — critical
  // for the attach-live path). Best-effort per route: a routing hiccup never fails
  // the migration, and the domain still shows in the project's Domains tab (its
  // service row is now exposed). Installing OpenResty when the box has none (a
  // foreign proxy still holds 80/443) is finished from that Domains tab. Once per
  // project (publishedRef).
  const applyRoutes = async (pid: string, routes: Record<string, PublicEndpoint[]>) => {
    if (publishedRef.current.has(pid)) return;
    publishedRef.current.add(pid);
    try {
      const { services } = await servicesApi.list(pid);
      const byName = new Map((services ?? []).map((s) => [s.name, s]));
      for (const [name, endpoints] of Object.entries(routes)) {
        const svc = byName.get(name);
        const ep = endpoints[0];
        if (!svc || !ep) continue;
        const domainValue = (ep.domainType === "custom" ? ep.customDomain : ep.domain)
          .trim()
          .toLowerCase();
        if (!domainValue) continue;
        await servicesApi
          .update(pid, svc.id, {
            exposed: true,
            exposedPort: ep.port || undefined,
            domainType: ep.domainType,
            ...(ep.domainType === "custom" ? { customDomain: domainValue } : { domain: domainValue }),
          })
          .catch(() => {}); // best-effort — domains never fail a migration
      }
    } catch {
      /* best-effort */
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

  // "Flat Docker" scan-mode toggle — shown beside the scan / re-scan control in
  // both footer states. Flipping it re-scans (when results are already shown).
  const flatToggle = (
    <label
      className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-muted-foreground shrink-0"
      title={m.wizard.flatDockerHint}
    >
      <input
        type="checkbox"
        checked={flatDocker}
        disabled={scanning}
        onChange={() => {
          const next = !flatDocker;
          setFlatDocker(next);
          if (selectedId && stack) void handleScan(next);
        }}
        className="size-3.5 rounded border-border/60 bg-card text-primary focus:ring-2 focus:ring-primary/30 focus:ring-offset-0 cursor-pointer"
      />
      {m.wizard.flatDocker}
    </label>
  );

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
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:hover:shadow-none disabled:hover:translate-y-0"
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
                        {stack.services
                          .filter((sv) => active.services.has(svcUid(sv)))
                          .map((sv) => (
                            <ServiceConfigCard
                              key={svcUid(sv)}
                              service={sv}
                              routes={active.serviceRoutes[svcUid(sv)]}
                              envOverride={active.serviceEnvs[svcUid(sv)]}
                              sameServer={sameServer}
                              volumeStrategy={volumeStrategy[svcUid(sv)]}
                              routeMode={
                                active.serviceRouteMode[svcUid(sv)] ??
                                (sv.existingRoute?.domains.length ? "keep" : "none")
                              }
                              onSetRoutes={(r) => setServiceRoutes(active.id, svcUid(sv), r)}
                              onSetEnv={(env) => setServiceEnv(active.id, svcUid(sv), env)}
                              onSetStrategy={(strat) =>
                                setVolumeStrategy((prev) => ({ ...prev, [svcUid(sv)]: strat }))
                              }
                              onSetRouteMode={(mode) => setServiceRouteMode(active.id, svcUid(sv), mode)}
                            />
                          ))}
                      </div>
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
                    {flatToggle}
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
                ) : (
                  /* Step 3 footer: move settings + Back + Migrate */
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
                        onClick={() => setStep("source")}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                      >
                        <ArrowLeft className="size-4" />
                        {m.wizard.steps.back}
                      </button>
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
                    </div>
                  </>
                )
              ) : (
                <>
                  {flatToggle}
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
        className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
      const running = !failed && !allDone && !awaiting;
      const railErr = run?.errorMessage || error;
      const railLabel = allDone
        ? queueTotal > 1
          ? interpolate(m.run.allSucceeded, { n: String(queueTotal) })
          : m.run.succeeded
        : awaiting
          ? m.run.awaiting_cutover
          : runText[runStatus] ?? m.run.queued;

      return (
        <div ref={stepTopRef} className="grid grid-cols-1 gap-6 items-start lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="rounded-2xl border border-border/50 bg-card p-6">
            <MigrationProgress
              run={run}
              error={error}
              queueName={queue?.[queueIndex]?.name ?? ""}
              queueIndex={queueIndex}
              queueTotal={queueTotal}
              completed={completed}
              deployServices={deploy?.services}
            />
          </div>

          <div className="rounded-2xl border border-border/50 bg-card p-5 space-y-4 lg:sticky lg:top-4">
            <div className="flex flex-col items-center gap-3 text-center">
              <span
                className={`inline-flex size-12 items-center justify-center rounded-2xl ${
                  failed
                    ? "bg-destructive/10 text-destructive"
                    : allDone || awaiting
                      ? "bg-success-bg text-success"
                      : "bg-primary/10 text-primary"
                }`}
              >
                {failed ? (
                  <AlertCircle className="size-6" />
                ) : allDone || awaiting ? (
                  <CheckCircle2 className="size-6" />
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

            {failed && railErr && (
              <div className="rounded-xl bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive">
                {railErr}
              </div>
            )}
            {awaiting && (
              <p className="text-xs leading-relaxed text-muted-foreground">{m.cutover.warning}</p>
            )}

            <div className="space-y-2">
              {awaiting ? (
                <>
                  <button type="button" onClick={() => handleCutover(true)} disabled={cutoverBusy} className="inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition-colors disabled:opacity-40">{cutoverBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{m.cutover.stopRemove}</button>
                  <button type="button" onClick={() => handleCutover(false)} disabled={cutoverBusy} className="w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-40">{m.cutover.keep}</button>
                </>
              ) : allDone ? (
                <>
                  <button type="button" onClick={openDomains} className="inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"><ArrowRight className="size-4" />{m.run.addDomains}</button>
                  <button type="button" onClick={openProject} className="w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">{m.run.openProject}</button>
                  <button type="button" onClick={close} className="w-full px-4 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">{m.wizard.close}</button>
                </>
              ) : (
                <>
                  {failed && run?.deploymentId && (
                    <button type="button" onClick={openDeployLogs} className="w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">{m.run.viewDeployLogs}</button>
                  )}
                  <button type="button" onClick={close} className="w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">{failed ? m.wizard.close : m.wizard.cancel}</button>
                </>
              )}
            </div>
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
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {m.wizard.transfer.label}
            <select value={transferMode} onChange={(e) => setTransferMode(e.target.value as typeof transferMode)} className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30">
              <option value="">{m.wizard.transfer.default}</option>
              <option value="auto">{m.wizard.transfer.auto}</option>
              <option value="stream">{m.wizard.transfer.stream}</option>
              <option value="direct">{m.wizard.transfer.direct}</option>
              <option value="rsync">{m.wizard.transfer.rsync}</option>
            </select>
          </label>
          <span className={`block text-xs ${sameServer ? "text-muted-foreground" : "text-warning"}`}>{sameServer ? m.wizard.sameServer : m.run.downtimeNote}</span>
          {crossServerBuiltSoon && <span className="block text-xs text-warning/90">{m.wizard.crossServerBuiltSoon}</span>}
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
          ) : (
            /* Configure — 2-grid of service cards on the left (like Select), the
               target card + finalize button reused in the right rail. */
            <div className="grid grid-cols-1 gap-6 items-start lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="grid min-w-0 grid-cols-1 gap-3.5 items-start xl:grid-cols-2">
                {picked.map((sv) => (
                  <ServiceConfigCard
                    key={svcUid(sv)}
                    service={sv}
                    routes={active.serviceRoutes[svcUid(sv)]}
                    envOverride={active.serviceEnvs[svcUid(sv)]}
                    sameServer={sameServer}
                    volumeStrategy={volumeStrategy[svcUid(sv)]}
                    routeMode={active.serviceRouteMode[svcUid(sv)] ?? (sv.existingRoute?.domains.length ? "keep" : "none")}
                    onSetRoutes={(r) => setServiceRoutes(active.id, svcUid(sv), r)}
                    onSetEnv={(env) => setServiceEnv(active.id, svcUid(sv), env)}
                    onSetStrategy={(strat) => setVolumeStrategy((prev) => ({ ...prev, [svcUid(sv)]: strat }))}
                    onSetRouteMode={(mode) => setServiceRouteMode(active.id, svcUid(sv), mode)}
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
                  <button type="button" onClick={handleMigrate} disabled={!canMigrate} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
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
          {/* Header (always on): Flat-Docker toggle lives at the top of the list
              so it's available before the first scan; project tabs + rescan join
              it once a scan has results. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              {adoptable && stack && (
                <>
              {projects.map((p) => {
                const on = p.id === active?.id;
                return (
                  <div
                    key={p.id}
                    className={`group inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                      on ? "border-primary/50 bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:bg-muted/40"
                    }`}
                    onClick={() => setActiveId(p.id)}
                  >
                    <Layers className={`size-3.5 ${on ? "text-primary" : ""}`} />
                    <span className="font-medium truncate max-w-[160px]">{p.name || m.wizard.projectName}</span>
                    <span className="text-xs text-muted-foreground">· {p.services.size}</span>
                    {projects.length > 1 && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeProject(p.id); }}
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
                </>
              )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {flatToggle}
                {adoptable && stack && rescanBtn}
              </div>
            </div>

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
                      className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                      {m.run.openProject}
                    </button>
                    <button type="button" onClick={openDomains}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
                      <ArrowRight className="size-4" />
                      {m.run.addDomains}
                    </button>
                  </>
                ) : (
                  <>
                    {failed && run?.deploymentId && (
                      <button type="button" onClick={openDeployLogs}
                        className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                        {m.run.viewDeployLogs}
                      </button>
                    )}
                    <button type="button" onClick={close}
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
                    {stack.services
                      .filter((sv) => active.services.has(svcUid(sv)))
                      .map((sv) => (
                        <ServiceConfigCard
                          key={svcUid(sv)}
                          service={sv}
                          routes={active.serviceRoutes[svcUid(sv)]}
                          envOverride={active.serviceEnvs[svcUid(sv)]}
                          sameServer={sameServer}
                          volumeStrategy={volumeStrategy[svcUid(sv)]}
                          routeMode={active.serviceRouteMode[svcUid(sv)] ?? (sv.existingRoute?.domains.length ? "keep" : "none")}
                          onSetRoutes={(r) => setServiceRoutes(active.id, svcUid(sv), r)}
                          onSetEnv={(env) => setServiceEnv(active.id, svcUid(sv), env)}
                          onSetStrategy={(strat) => setVolumeStrategy((prev) => ({ ...prev, [svcUid(sv)]: strat }))}
                          onSetRouteMode={(mode) => setServiceRouteMode(active.id, svcUid(sv), mode)}
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
                      <span className={`block text-xs ${sameServer ? "text-muted-foreground" : "text-warning"}`}>
                        {sameServer ? m.wizard.sameServer : m.run.downtimeNote}
                      </span>
                      {crossServerBuiltSoon && <span className="block text-xs text-warning/90">{m.wizard.crossServerBuiltSoon}</span>}
                    </div>
                  </div>
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
                ) : (
                  <>
                    <button type="button" onClick={() => setStep("source")}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
                      <ArrowLeft className="size-4" />
                      {m.wizard.steps.back}
                    </button>
                    <button type="button" onClick={handleMigrate} disabled={!canMigrate}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                      {starting ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                      {migratable.length > 1 ? interpolate(m.wizard.migrateN, { n: String(migratable.length) }) : m.wizard.migrate}
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              {server && <ServerConnectionCard server={server} />}
              <div className="rounded-2xl border border-border/50 bg-card p-5 space-y-3.5">
                <div className="flex items-center gap-2.5">
                  <div className="size-9 rounded-xl bg-primary/10 ring-1 ring-inset ring-primary/20 flex items-center justify-center shrink-0">
                    <Boxes className="size-[18px] text-primary" />
                  </div>
                  <h3 className="text-sm font-semibold text-foreground leading-tight">{m.entry.cardTitle}</h3>
                </div>
                <p className="text-[13px] leading-relaxed text-muted-foreground">{m.entry.cardDesc}</p>
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
            </>
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
        <div className="mt-1 flex items-center gap-4 opacity-40" aria-hidden>
          {MIGRATE_SOURCES.map((slug) => (
            <AppLogo key={slug} slug={slug} className="size-5 grayscale" />
          ))}
          <ArrowRight className="size-4 text-muted-foreground/60" />
          <Logo size={20} />
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
            ? "cursor-default border-primary/30 bg-primary/[0.05]"
            : checked
              ? "cursor-pointer border-primary/40 bg-primary/[0.05]"
              : "cursor-pointer border-border/50 bg-card hover:border-border hover:bg-muted/20"
      }`}
    >
      <span
        className={`mt-0.5 size-[18px] rounded-md border flex items-center justify-center shrink-0 transition-colors ${
          interactionBlocked
            ? "border-border bg-muted"
            : checked
              ? "bg-primary border-primary text-primary-foreground"
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

      {/* Quiet status — no loud filled pill; running takes the on-brand success
          tint, the notable "stopped" state the warning tint. */}
      <span
        className={`mt-0.5 shrink-0 text-[11px] font-medium uppercase tracking-wide ${
          service.running ? "text-success" : "text-warning"
        }`}
      >
        {service.running ? m.running : m.stopped}
      </span>
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
                    <span className="font-mono text-[10px] text-muted-foreground">{c.build}</span>
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
                      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80" title={sv.image || sv.build}>
                        {sv.image || `${t.migration.discover.build}: ${sv.build}`}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                      {s.mapField}
                    </label>
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
  routes,
  envOverride,
  sameServer,
  volumeStrategy,
  routeMode,
  onSetRoutes,
  onSetEnv,
  onSetStrategy,
  onSetRouteMode,
}: {
  service: DiscoveredService;
  routes: PublicEndpoint[] | undefined;
  envOverride: Record<string, string> | undefined;
  sameServer: boolean;
  volumeStrategy: VolumeStrategy | undefined;
  routeMode: RouteMode;
  onSetRoutes: (routes: PublicEndpoint[]) => void;
  onSetEnv: (env: Record<string, string>) => void;
  onSetStrategy: (strat: VolumeStrategy) => void;
  onSetRouteMode: (mode: RouteMode) => void;
}) {
  const { t } = useI18n();
  const s = t.migration.wizard.steps;
  const d = t.migration.discover;
  const port = routes?.[0]?.port ?? firstContainerPort(service);
  const [showEnv, setShowEnv] = useState(false);
  const existing = service.existingRoute;
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
        mode === "custom" && routeMode === "keep" && existing?.domains[0]
          ? { ...base, domainType: "custom", customDomain: existing.domains[0] }
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

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Container className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground truncate">{service.name}</span>
        {service.ports.map((p, i) => (
          <span
            key={`${p}-${i}`}
            className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {p}
          </span>
        ))}
      </div>

      {/* Route: Free / Custom / None (+ Keep when a route was already detected) */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Globe className="size-3.5 text-muted-foreground" />
          <span className="text-[13px] font-medium text-muted-foreground">{s.routeTitle}</span>
          {existing && (
            <span
              className={`ms-auto rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                existing.ssl.enabled ? "bg-success-bg text-success" : "bg-muted/60 text-muted-foreground"
              }`}
            >
              {existing.ssl.enabled ? s.sslOn : s.sslOff}
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

        {/* Reserve a stable height so switching Keep/Custom/None doesn't jump the
            card (None's short note used to collapse it). */}
        <div className="flex min-h-[3rem] flex-col justify-center">
          {routeMode === "keep" && existing && (
            <div className="rounded-lg border border-border/50 bg-card/40 px-3 py-2">
              <a
                href={`https://${existing.domains[0]}`}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-sm text-foreground hover:text-primary transition-colors"
              >
                {existing.domains[0]}
              </a>
              {existing.domains.length > 1 && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">+{existing.domains.length - 1}</p>
              )}
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
      </div>

      {volumeNames.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card/40 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">{d.volumesTitle}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{volumeNames.join(", ")}</p>
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

      <div>
        <button
          type="button"
          onClick={() => setShowEnv((v) => !v)}
          className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className={`size-3.5 transition-transform ${showEnv ? "rotate-90" : ""}`} />
          {s.envTitle}
          <span className="text-muted-foreground/60">· {Object.keys(envRecord).length}</span>
        </button>
        {showEnv && (
          <div className="mt-2">
            <EnvironmentVariables
              mode="settings"
              borderless
              envVars={envRows}
              onEnvVarsChange={(rows) => onSetEnv(rowsToEnv(rows))}
            />
          </div>
        )}
      </div>
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
    </div>
  );
}
