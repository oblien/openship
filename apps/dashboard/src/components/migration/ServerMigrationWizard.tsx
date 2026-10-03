"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { usePlatform } from "@/context/PlatformContext";
import { useSession } from "@/lib/auth-client";
import { Modal } from "@/components/ui/Modal";
import ServerSelector, {
  ServerSelectorView,
  useServerSelection,
  type ServerOption,
} from "@/components/shared/ServerSelector";
import { useCloudDeployPricing } from "@/hooks/useCloudDeployPricing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import {
  dockerMigrationApi,
  isScanStreamStalled,
  deployApi,
  githubApi,
  getApiErrorMessage,
  type DiscoveredStack,
  type DiscoveredGroup,
  type DiscoveredService,
  type ComposeRepoService,
  type MigrationRun,
  type MigrationStatus,
  type TransferProgress,
  type MigrationPreview,
  type CustomPath,
  type PendingItem,
  type ConflictAction,
} from "@/lib/api";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { parseSessionLog } from "./session-log-line";
import {
  keptServiceRoutes,
  toServerRoutes,
  firstContainerPort,
  hasKeepableRoute,
  hasIncompleteServiceRoutes,
  type RouteMode,
} from "./migration-route-input";
import { DiscoveredProjects, type DiscoveryView } from "./DiscoveredProjects";
import {
  MigrationServiceReview,
  type DeployAction,
  type VolumeStrategy,
} from "./MigrationServiceReview";
import {
  isExcluded,
  svcUid,
  STANDALONE,
  groupKey,
  selectableServices,
  selectedGroupKey,
} from "./discovery-model";
import { MigrationPrompt } from "./MigrationPrompt";
import { MigrationProxyReview } from "./MigrationProxyReview";
import { RecoveredProjectReview, type RecoveryResult } from "./RecoveredProjectReview";
import { useGitHub } from "@/context/GitHubContext";
import { RepositoryList } from "@/app/(dashboard)/library/components/RepositoryList";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { RepositoryBranchSelect } from "@/components/github/RepositoryBranchSelect";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { type PublicEndpoint } from "@/context/deployment/types";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { randomUUID } from "@/lib/random-uuid";
import { extractOwnerRepoFromUrl } from "@/utils/repoSlug";
import { AppLogo } from "@/components/AppLogo";
import { ServiceIcon } from "@/components/services/ServiceIcon";
import { Logo } from "@/components/logo";
import { DeploymentTerminal } from "@/components/import-project/DeploymentTerminal";
import { ServerConnectionCard } from "@/app/(dashboard)/servers/[serverId]/_components/connection-card";
import { MigrationIllustration } from "@/components/migration/MigrationIllustration";

/** Platforms whose Docker/Compose apps this flow can adopt — shown as faint,
 *  clean brand marks under the intro (decorative). Only brands with a crisp
 *  simpleicons mark (blurry favicon sources dropped); the Openship circle is
 *  appended as the destination. */
const MIGRATE_SOURCES = ["coolify", "caprover", "docker"] as const;
const EMPTY_SELECTION = { id: "", name: "", services: new Set<string>() };

/** Synthesize a DiscoveredService-shaped card model from a repo compose service
 *  that has NO running container (e.g. `redis`, or a `build:` app that isn't
 *  running). It renders through the shared MigrationServiceReview — env from the repo
 *  compose, route controls, no volumes/keep — so a migration screen is the full
 *  native service list, and these services deploy (build/pull) from the repo. */
const synthServiceFromRepo = (c: ComposeRepoService): DiscoveredService => ({
  name: c.name,
  source: "compose",
  running: false,
  image: c.image,
  build: c.build,
  dockerfile: c.dockerfile,
  buildArgs: c.buildArgs,
  ports: c.ports ?? [],
  env: c.environment ?? {},
  volumes: [],
  networks: [],
  dependsOn: c.dependsOn ?? [],
  warnings: [],
});

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
function buildPlanCards(project: ImportProject, services: DiscoveredService[]): PlanCard[] {
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

const RUN_PHASES: MigrationStatus[] = ["adopting", "moving_data", "deploying", "verifying"];

/**
 * `project:run:status` triples whose project refresh has already been fired.
 *
 * Module scope on purpose — see the effect that uses it. It grows by a handful of entries per
 * migration and is only consulted for the run on screen, so it is left unbounded rather than
 * given an eviction policy that could drop a key and re-open the loop it exists to close.
 */
const publishedPhases = new Set<string>();

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
 * One Openship project to create from the scan. Services may come from multiple
 * groups; `bound` only supplies the initial project name (null until the first pick).
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

interface MigrateItem {
  name: string;
  serviceNames: string[];
  /** Container ids of the picked services (`svcUid`). Sent alongside the names so the
   *  server resolves the selection by IDENTITY: a compose service name is only unique
   *  within its own stack, so a name-only migrate also matched same-named containers
   *  from every other stack on the host — including Openship's own `postgres` (#584). */
  serviceContainerIds?: string[];
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
  origin = "server",
}: {
  isOpen?: boolean;
  onClose: () => void;
  serverId?: string;
  /** "modal" wraps in a Modal; "tab" renders the shared inline flow in New
   *  Project or the server-detail Migrations tab. */
  variant?: "modal" | "tab";
  /** Connection summary for the tab's right column before a scan (server detail). */
  server?: {
    sshHost: string;
    sshPort?: number | null;
    sshUser?: string | null;
    sshAuthMethod?: string | null;
  } | null;
  /** Open directly on an existing run's progress/steps/logs (any status,
   *  incl. terminal) — the Migrations list opens a row straight into this. */
  initialRunId?: string;
  /** Tab variant: renders a compact inline "← Back" (to the runs list) in the
   *  header rows, so it never adds a full row that pushes the layout down. */
  onBack?: () => void;
  /**
   * WHERE this panel was opened from, which decides whether the scan flow exists at all.
   *
   * `"server"` (default) is the original entry: pick a server, scan it, choose containers, then
   * migrate. `"project"` is a project moving or duplicating itself — the workload is already
   * decided by the project's own containers, so there is nothing to scan and nothing to select.
   *
   * This is a gate, not a style. Without it, any state that leaves `inProgress` false — a run
   * that finished, a run id that no longer resolves, a retry — rendered the server scan screen
   * inside a project's Advanced tab, offering to adopt containers from a box the operator had
   * not asked about.
   */
  origin?: "server" | "project";
}) {
  const { t } = useI18n();
  const m = t.migration;
  const { selfHosted } = usePlatform();
  const { data: session } = useSession();
  const ownerKey = `${session?.user.id ?? "local"}:${session?.session.activeOrganizationId ?? ""}`;
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const previousOwnerRef = useRef(ownerKey);
  const router = useRouter();
  const github = useGitHub();

  // All imports review their destination after configuring services.
  const [step, setStep] = useState<"select" | "source" | "domains" | "plan">("select");
  const [discoveryView, setDiscoveryView] = useState<DiscoveryView>("cards");
  const [recoveryId, setRecoveryId] = useState<string | null>(null);
  const [recoveryResults, setRecoveryResults] = useState<Record<string, RecoveryResult>>({});
  const [expandedServices, setExpandedServices] = useState<Record<string, Set<string>>>({});

  // Each step's content is a very different height; without resetting scroll a
  // step change (esp. Next from a scrolled-down list) leaves the viewport parked
  // in empty space. Bring the current step's top back into view (tab variant).
  const stepTopRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stepTopRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [step]);

  const [selectedId, setSelectedId] = useState<string | null>(serverId ?? null);
  const [targetId, setTargetId] = useState<string | null>(selfHosted ? (serverId ?? null) : null);
  const [serverName, setServerName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // "Flat Docker" scan mode: ignore openship.* labels so managed workloads adopt
  // as plain compose/standalone (no re-import). Off = Openship-aware (default).
  const [flatDocker, setFlatDocker] = useState(!selfHosted);
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
  const [completed, setCompleted] = useState<
    Array<{ name: string; projectId?: string | null; warning?: string | null }>
  >([]);
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
  /** Bumped by every scan and every reset; a scan whose generation has moved on has
   *  lost its claim on the wizard's state. See handleScan. */
  const scanGen = useRef(0);
  const repoRequests = useRef(new Map<string, RepoLink | null>());
  const visible = variant === "tab" || !!isOpen;
  const claimOperation = () => {
    const generation = scanGen.current;
    return () => scanGen.current === generation && ownerRef.current === ownerKey;
  };
  const targetSelection = useServerSelection(
    {
      value: targetId,
      autoSelectFirst: true,
      onSelect: (selected) => {
        if (selected?.id === targetId) return;
        setTargetId(selected?.id ?? null);
        setPlanReady(false);
        setConflictResolution({});
      },
    },
    visible && !initialRunId,
  );
  const handleCloudPricing = useCloudDeployPricing(targetSelection.selected?.managed?.id);

  useEffect(
    () => () => {
      scanGen.current++;
    },
    [],
  );

  const reset = () => {
    setStep("select");
    setDiscoveryView("cards");
    setRecoveryId(null);
    setRecoveryResults({});
    setExpandedServices({});
    setStack(null);
    setError(null);
    setProjects([]);
    setActiveId(null);
    setVolumeStrategy({});
    setScanning(false);
    setScanStatus("");
    setPlanReady(false);
    setKillOriginals(false);
    setTransferMode("");
    setCompress(false);
    setCustomPaths([]);
    setConflictResolution({});
    planCacheRef.current.clear();
    repoRequests.current.clear();
    scanGen.current++;
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
    setCleanupBusy(false);
    setRetrying(false);
    setParsingRepo(null);
    setDeploy(null);
  };

  useEffect(() => {
    if (previousOwnerRef.current === ownerKey) return;
    previousOwnerRef.current = ownerKey;
    reset();
    setSelectedId(serverId ?? null);
    setTargetId(selfHosted ? (serverId ?? null) : null);
  }, [ownerKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const isCurrent = claimOperation();
    setDeleteBusy(true);
    try {
      await dockerMigrationApi.remove(migrationId);
      if (isCurrent()) close();
    } catch (e) {
      if (!isCurrent()) return;
      setError(getApiErrorMessage(e, m.adoptFailed));
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
    const isCurrent = claimOperation();
    setCleanupBusy(true);
    try {
      await dockerMigrationApi.cleanupTarget(migrationId);
      if (isCurrent()) setRun((prev) => (prev ? { ...prev, targetVolumes: [] } : prev));
    } catch (e) {
      if (isCurrent()) setError(getApiErrorMessage(e, m.adoptFailed));
    } finally {
      if (isCurrent()) setCleanupBusy(false);
    }
  };

  /**
   * Is this run a PROJECT move/duplicate rather than a scan-started adopt?
   *
   * The two need different failure recovery, and conflating them is what put an operator who
   * clicked "Edit & retry" on a project's Advanced tab into a full server scan — "Existing
   * services / Flat listing / Scanning existing reverse proxy…", door A's UI, for a run that
   * never involved choosing containers.
   */
  const projectRun = run?.mode === "project_move" || run?.mode === "project_copy";
  const projectMoveSnapshot = (
    run?.inputSnapshot as
      | { projectMove?: { projectId?: string; intent?: string; serviceNames?: string[] } }
      | null
      | undefined
  )?.projectMove;

  /**
   * Retry a failed PROJECT run with the same inputs — one click, no scan.
   *
   * The right move for what actually fails here: an unreachable host, a rejected key, a
   * transient network drop. Nothing about the workload needs re-choosing, and the workload is
   * re-resolved server-side anyway (the run's `adopting` phase reads the project's own
   * containers), so a retry always acts on current truth rather than a stale selection.
   */
  const [retrying, setRetrying] = useState(false);
  const retryProjectRun = async () => {
    const snap = projectMoveSnapshot;
    if (!snap?.projectId || retrying) return;
    const isCurrent = claimOperation();
    setRetrying(true);
    try {
      const res = await dockerMigrationApi.startProjectMove({
        projectId: snap.projectId,
        targetServerId: run?.targetServerId ?? "",
        intent: snap.intent === "copy" ? "copy" : "move",
        serviceNames: snap.serviceNames,
      });
      if (!isCurrent()) return;
      // Re-point this panel at the NEW run. The failed run's record stays, as it does for a
      // scan retry — the history is how you see that the first attempt happened.
      setMigrationId(res.migrationId);
      setConfirmToken(res.confirmationToken);
      setRun(null);
      setProgress(null);
      setQueue([{ name: "", serviceNames: [], volumeStrategies: {} }]);
      setQueueIndex(0);
      setCompleted([]);
    } catch (e: unknown) {
      if (isCurrent()) setError(getApiErrorMessage(e, m.tab.editRetry));
    } finally {
      if (isCurrent()) setRetrying(false);
    }
  };

  // Failed → "Edit & retry": drop back into a fresh flow on the SAME server
  // with the prior custom paths restored, re-scan, and let the user adjust
  // (services / env / paths) before re-running. The failed run's record stays.
  //
  // SCAN-started runs only. A project run has no scan to go back to; it retries in place or
  // returns to the card that started it (see `retryProjectRun` above and `onBack`).
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
    if (selfHosted) setTargetId(s?.id ?? null);
  };

  const handleScan = async (flatOverride?: boolean) => {
    if (!selectedId) return;
    const flat = !selfHosted || (flatOverride ?? flatDocker);
    // The fallback below can land up to two minutes after the stream gave up, and
    // closing the wizard does NOT unmount this component — only the Modal's children
    // go. Without a claim check, a scan the user walked away from repopulates the
    // stack, and of the wrong server if they picked another one meanwhile.
    const gen = ++scanGen.current;
    const stale = () => scanGen.current !== gen || ownerRef.current !== ownerKey;
    setScanning(true);
    setScanStatus("");
    setError(null);
    setStack(null);
    setProjects([]);
    setStep("select");
    setRecoveryId(null);
    setRecoveryResults({});
    setExpandedServices({});
    try {
      // Stream the inspect (SSE): step progress + no total-duration bound, so a slow
      // SSH + docker inspect doesn't get aborted (the old plain POST hit the 15s
      // client default through the same-origin proxy). When the STREAM is what fails
      // — an intermediary buffering text/event-stream, GH-570 — the plain POST still
      // beats a spinner that never stops, so take it silently: same stack, only
      // without the progress lines.
      const scanned = await dockerMigrationApi
        .scanStream(selectedId, {
          onProgress: (message) => {
            if (!stale()) setScanStatus(message);
          },
          flatDocker: flat,
        })
        .catch(async (e: unknown) => {
          if (stale()) throw e;
          if (!isScanStreamStalled(e)) throw e;
          // Recovered, but an operator's proxy is still misconfigured — say so
          // somewhere rather than hiding it behind a scan that silently got slower.
          // The aborted scan also keeps running server-side; it's read-only.
          console.warn(`[migration] ${(e as Error).message} — falling back to a plain scan`);
          return (await dockerMigrationApi.scan(selectedId, { flatDocker: flat })).stack;
        });
      if (stale()) return;
      setStack(scanned);
      if (!scanned.adoptable && !scanned.openshipProjects?.some((project) => !project.knownHere)) {
        setError(m.discover.nothing);
        return;
      }
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
      if (stale()) return;
      setError(getApiErrorMessage(e, m.scanFailed));
    } finally {
      if (!stale()) setScanning(false);
    }
  };

  // ── Project (tab) ops ──────────────────────────────────────────────────────
  const active = useMemo(
    () => projects.find((p) => p.id === activeId) ?? projects[0] ?? null,
    [projects, activeId],
  );

  const setServiceExpansion = (uids: string[], expanded: boolean) => {
    if (!active) return;
    setExpandedServices((previous) => {
      const next = new Set(previous[active.id]);
      for (const uid of uids) {
        if (expanded) next.add(uid);
        else next.delete(uid);
      }
      return { ...previous, [active.id]: next };
    });
  };

  // service name → the project id that already claimed it (exclusive assignment).
  const claimedBy = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) for (const s of p.services) map.set(s, p.id);
    return map;
  }, [projects]);

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
  ) =>
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, composeServices, serviceMap } : p)),
    );

  const setServiceMap = (id: string, uid: string, composeName: string | null) =>
    setProjects((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, serviceMap: { ...p.serviceMap, [uid]: composeName } } : p,
      ),
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
    repoRequests.current.set(projectId, repo);
    const ownsWizard = claimOperation();
    const isCurrent = () => ownsWizard() && repoRequests.current.get(projectId) === repo;
    setProjectRepo(projectId, repo);
    if (!repo) {
      setParsingRepo((current) => (current === projectId ? null : current));
      return;
    }
    setParsingRepo(projectId);
    try {
      const res = await dockerMigrationApi.parseRepoCompose(repo.owner, repo.repo, repo.branch);
      if (!isCurrent()) return;
      const services = res?.services ?? [];
      const names = services.map((s) => s.name);
      const proj = projects.find((p) => p.id === projectId);
      const map: Record<string, string | null> = {};
      for (const s of stack?.services ?? []) {
        if (proj?.services.has(svcUid(s))) map[svcUid(s)] = autoMatchCompose(s.name, names);
      }
      setProjectCompose(projectId, services, map);
    } catch {
      if (isCurrent()) setProjectCompose(projectId, [], {});
    } finally {
      if (isCurrent()) setParsingRepo((current) => (current === projectId ? null : current));
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
  const toggleService = (svc: DiscoveredService, key: string) => {
    if (!active || isExcluded(svc)) return;
    setRecoveryId(null);
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
          services.add(uid);
        }
        const nextBound = selectedGroupKey(stack?.groups ?? [], services, p.bound ?? key);
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
    setRecoveryId(null);
    const key = groupKey(group);
    const uids = selectableServices(group, active.id, claimedBy).map(svcUid);
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
        const nextBound = selectedGroupKey(stack?.groups ?? [], services, p.bound ?? key);
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
  const adoptable = Boolean(
    stack?.adoptable &&
    stack.groups.some((group) => group.services.some((service) => !isExcluded(service))),
  );
  // Openship projects on the server that this instance doesn't know → re-importable.
  const orphanedOpenship = useMemo(
    () => stack?.openshipProjects?.filter((p) => !p.knownHere) ?? [],
    [stack],
  );
  const hasReimport = orphanedOpenship.length > 0;
  const recoveredProject = orphanedOpenship.find((project) => project.projectId === recoveryId);
  const sameServer = selectedId === targetId;
  // Cross-server now MOVES locally-built images as data (docker save|load) — no
  // registry, no rebuild. Surface an info note up front (the image stream can be
  // large/slow) when a built service exists and a different target is picked.
  const crossServerBuiltInfo =
    !sameServer && Boolean(stack?.services.some((s) => Boolean(s.build)));
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
  // The same union by IDENTITY — the plan is sized from this set, so a name-only
  // preview also sized another stack's volumes into this migration (#584).
  const planServiceContainerIds = useMemo(
    () =>
      Array.from(
        new Set(
          migratable.flatMap((p) =>
            (stack?.services ?? [])
              .filter((s) => p.services.has(svcUid(s)))
              .map((s) => s.containerId)
              .filter((id): id is string => Boolean(id)),
          ),
        ),
      ),
    [migratable, stack],
  );
  const unfinishedRoutes = migratable.flatMap((project) =>
    buildPlanCards(project, stack?.services ?? [])
      .filter(({ uid, service }) =>
        hasIncompleteServiceRoutes(
          project.serviceRouteMode[uid] ?? (hasKeepableRoute(service) ? "keep" : "none"),
          project.serviceRoutes[uid],
        ),
      )
      .map(({ service }) => `${project.name} / ${service.name}`),
  );
  const canMigrate =
    Boolean(selectedId) &&
    Boolean(targetId) &&
    targetSelection.ready &&
    migratable.length > 0 &&
    unfinishedRoutes.length === 0 &&
    !parsingRepo &&
    !starting &&
    !queue;

  const discoveredProjects = stack ? (
    <DiscoveredProjects
      key={`${ownerKey}:${selectedId}:${scanGen.current}`}
      groups={stack.groups.filter((group) =>
        group.services.some((service) => !isExcluded(service)),
      )}
      recovered={orphanedOpenship}
      recoveryId={recoveryId}
      onSelectRecovery={setRecoveryId}
      activeProject={active ?? EMPTY_SELECTION}
      projects={projects}
      claimedBy={claimedBy}
      view={discoveryView}
      onViewChange={setDiscoveryView}
      onToggle={(service, group) => toggleService(service, groupKey(group))}
      onToggleGroup={toggleGroup}
    />
  ) : null;
  const projectNameField = active ? (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`import-name-${active.id}`} className="text-sm font-medium text-foreground">
          {m.wizard.projectName}
        </label>
        {active.services.size > 0 &&
          stack?.services.some(
            (service) => !isExcluded(service) && !claimedBy.has(svcUid(service)),
          ) && (
            <Button type="button" variant="ghost" size="sm" onClick={addProject}>
              {m.wizard.addProject}
            </Button>
          )}
      </div>
      <Input
        id={`import-name-${active.id}`}
        variant="filled"
        value={active.name}
        onChange={(event) => renameProject(active.id, event.target.value)}
        placeholder={m.wizard.projectNamePlaceholder}
      />
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {active.services.size
          ? interpolate(m.tab.servicesCount, { n: String(active.services.size) })
          : m.discover.emptyProject}
      </p>
    </div>
  ) : null;
  const reviewCards = active && stack ? buildPlanCards(active, stack.services) : [];
  const expandedReviewCount = reviewCards.filter(
    ({ uid }) => active && expandedServices[active.id]?.has(uid),
  ).length;
  const serviceReviews =
    stack && active ? (
      <div className="@container/review space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">{m.review.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{m.review.hint}</p>
          </div>
          <div
            role="group"
            aria-label={m.review.title}
            className="flex max-w-full flex-wrap gap-1 rounded-xl bg-card p-1"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={expandedReviewCount === reviewCards.length}
              onClick={() =>
                setServiceExpansion(
                  reviewCards.map(({ uid }) => uid),
                  true,
                )
              }
            >
              {m.review.expandAll}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={expandedReviewCount === 0}
              onClick={() =>
                setServiceExpansion(
                  reviewCards.map(({ uid }) => uid),
                  false,
                )
              }
            >
              {m.review.collapseAll}
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-1 items-start gap-4 @[640px]/review:grid-cols-2">
          {reviewCards.map(({ uid, service, isNew, action }) => (
            <MigrationServiceReview
              key={`${active.id}:${uid}`}
              service={service}
              sourceServerId={selectedId}
              isNew={isNew}
              deployAction={action}
              expanded={expandedServices[active.id]?.has(uid) ?? false}
              onExpandedChange={(expanded) => setServiceExpansion([uid], expanded)}
              routes={active.serviceRoutes[uid]}
              envOverride={active.serviceEnvs[uid]}
              sameServer={sameServer}
              volumeStrategy={volumeStrategy[uid]}
              routeMode={
                active.serviceRouteMode[uid] ?? (hasKeepableRoute(service) ? "keep" : "none")
              }
              onSetRoutes={(routes) => setServiceRoutes(active.id, uid, routes)}
              onSetEnv={(env) => setServiceEnv(active.id, uid, env)}
              onSetStrategy={(strategy) =>
                setVolumeStrategy((previous) => ({ ...previous, [uid]: strategy }))
              }
              onSetRouteMode={(mode) => setServiceRouteMode(active.id, uid, mode)}
            />
          ))}
        </div>
        {unfinishedRoutes.length > 0 && (
          <p role="status" className="rounded-xl bg-warning-bg p-3 text-sm text-warning">
            {m.review.finishRouteHint}{" "}
            <span className="block text-xs">{unfinishedRoutes.join(", ")}</span>
          </p>
        )}
      </div>
    ) : null;
  const steps: (typeof step)[] = ["select", "source", "domains", "plan"];
  const stepIndex = steps.indexOf(step);
  const stepNavigation = (
    <nav aria-label={m.review.progress} className="rounded-xl bg-card p-1.5">
      <ol className="flex items-center justify-between gap-1">
        {steps.map((value, index) => (
          <li key={value}>
            <button
              type="button"
              disabled={index > stepIndex}
              aria-current={value === step ? "step" : undefined}
              onClick={() => setStep(value)}
              aria-label={value === "plan" ? m.review.destination : m.wizard.steps[value]}
              title={value === "plan" ? m.review.destination : m.wizard.steps[value]}
              className={`inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-ring ${value === step ? "bg-background font-medium text-foreground" : "text-muted-foreground"}`}
            >
              <span
                className={`flex size-6 items-center justify-center rounded-full text-xs ${value === step ? "bg-foreground text-background" : "bg-muted/60"}`}
              >
                {index < stepIndex ? <UiIcon name="check" className="size-3.5" /> : index + 1}
              </span>
              {value === step && (
                <span>{value === "plan" ? m.review.destination : m.wizard.steps[value]}</span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
  const cleanupChoice = (
    <div className="flex items-start gap-2.5">
      <Checkbox
        id="migration-remove-originals"
        checked={killOriginals}
        onCheckedChange={setKillOriginals}
        className="mt-0.5"
      />
      <label
        htmlFor="migration-remove-originals"
        className="cursor-pointer text-sm text-foreground"
      >
        {m.wizard.killOriginals}
      </label>
    </div>
  );

  // Both import presentations use the same destination and cleanup controls.
  const targetCard = (
    <div className="rounded-2xl bg-card p-5 space-y-4">
      <h3 className="text-base font-semibold text-foreground">{m.wizard.targetLabel}</h3>
      <ServerSelectorView selection={targetSelection} compact />
      {cleanupChoice}
      <span className={`block text-xs ${sameServer ? "text-muted-foreground" : "text-warning"}`}>
        {sameServer ? m.wizard.sameServer : m.run.downtimeNote}
      </span>
      {crossServerBuiltInfo && (
        <span className="block text-xs text-muted-foreground">{m.wizard.crossServerBuiltInfo}</span>
      )}
    </div>
  );
  const publicServices = reviewCards.filter(
    ({ uid, service }) =>
      (active!.serviceRouteMode[uid] ?? (hasKeepableRoute(service) ? "keep" : "none")) !== "none",
  ).length;
  const reviewSummary = (
    <section className="space-y-4 rounded-2xl bg-card p-5" aria-label={m.review.summary}>
      <div>
        <h3 className="text-base font-semibold text-foreground">{m.review.summary}</h3>
        <p className="mt-1 truncate text-sm text-muted-foreground" title={active?.name}>
          {active?.name}
        </p>
      </div>
      <dl className="space-y-3 text-sm">
        {[
          [m.discover.servicesTitle, reviewCards.length],
          [m.review.publicServices, publicServices],
          [m.review.internalServices, reviewCards.length - publicServices],
          [
            m.review.dataMounts,
            reviewCards.reduce((count, { service }) => count + service.volumes.length, 0),
          ],
        ].map(([label, count]) => (
          <div key={label} className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="tabular-nums text-foreground">{count}</dd>
          </div>
        ))}
      </dl>
      {active?.repo && (
        <div className="min-w-0 border-t border-border/50 pt-3">
          <p className="text-xs text-muted-foreground">{m.wizard.steps.source}</p>
          <p
            className="mt-1 truncate text-sm text-foreground"
            title={`${active.repo.owner}/${active.repo.repo}`}
          >
            {active.repo.owner}/{active.repo.repo}
          </p>
        </div>
      )}
      {step === "domains" && (
        <p className="text-xs text-muted-foreground">{m.review.destinationNext}</p>
      )}
    </section>
  );

  // ── Migrate (sequential, one project at a time) ────────────────────────────
  const startMigration = async (item: MigrateItem, fromRecovery = false): Promise<void> => {
    if (!selectedId || !targetId || !targetSelection.ready) return;
    const generation = scanGen.current;
    const stale = () => scanGen.current !== generation || ownerRef.current !== ownerKey;
    setStarting(true);
    setError(null);
    try {
      const res = await dockerMigrationApi.migrate({
        sourceServerId: selectedId,
        targetServerId: targetId,
        serviceNames: item.serviceNames,
        serviceContainerIds: item.serviceContainerIds,
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
        flatDocker: !selfHosted || flatDocker,
      });
      if (stale()) return;
      setMigrationId(res.migrationId);
      setConfirmToken(res.confirmationToken);
      setRun({
        id: res.migrationId,
        status: "queued",
        mode: sameServer ? "same_server" : "cross_server",
      });
    } catch (e) {
      if (stale()) return;
      setError(getApiErrorMessage(e, m.adoptFailed));
      if (fromRecovery) throw e;
      handleCloudPricing(e, async () => {
        if (!stale()) await startMigration(item, true);
      });
    } finally {
      if (!stale()) setStarting(false);
    }
  };

  const handleMigrate = () => {
    if (!canMigrate) return;
    // Selection is keyed by uid, and so are the per-service maps we send: the server
    // reads them back with the same precedence (`perService` — uid, then name), so a
    // service keeps its own volume strategy / env / route even when another selected
    // stack has a service by the same name. Collapsing these onto names is what let a
    // "reuse in place" choice be applied to the wrong container (#584 class). Repo
    // compose services with no container are still keyed by name below — they have no
    // uid, and the server's name fallback is for exactly them. Copy choices apply only
    // to same-server migrations (cross-server always copies A→B and keeps A).
    const items: MigrateItem[] = migratable.map((p) => {
      const picked = (stack?.services ?? []).filter((s) => p.services.has(svcUid(s)));
      const volumeStrategies: Record<string, VolumeStrategy> = {};
      if (sameServer) {
        for (const s of picked) {
          if (volumeStrategy[svcUid(s)] === "copy") volumeStrategies[svcUid(s)] = "copy";
        }
      }
      // The build subpath is DERIVED from the discovered→compose mapping (the matched
      // compose service's build context).
      const composeByName = new Map(p.composeServices.map((c) => [c.name, c]));
      const serviceSubpaths: Record<string, string> = {};
      const serviceRenames: Record<string, string> = {};
      const serviceEnv: Record<string, Record<string, string>> = {};
      const routesByServiceName: Record<string, PublicEndpoint[]> = {};
      for (const s of picked) {
        const mapped = p.serviceMap[svcUid(s)];
        const build = mapped ? composeByName.get(mapped)?.build?.trim() : undefined;
        if (build) serviceSubpaths[svcUid(s)] = build;
        // Adopt the row under the mapped REPO compose service name so a later
        // git-compose reconcile matches it in place (no duplicate / empty volume).
        if (mapped && mapped !== s.name) serviceRenames[svcUid(s)] = mapped;
        const env = p.serviceEnvs[svcUid(s)];
        if (env) serviceEnv[svcUid(s)] = env; // only edited services carry an override
        // Resolve the route by the per-container mode. "keep" reuses the domain
        // the foreign proxy already served; free/custom take the editor value
        // (domain-less placeholders filtered here, not mid-edit); none → skip.
        const uid = svcUid(s);
        const mode: RouteMode = p.serviceRouteMode[uid] ?? (hasKeepableRoute(s) ? "keep" : "none");
        let routes: PublicEndpoint[] = [];
        if (mode === "keep" && hasKeepableRoute(s)) {
          routes = keptServiceRoutes(s, firstContainerPort(s));
        } else if (mode === "free" || mode === "custom") {
          routes = (p.serviceRoutes[uid] ?? []).filter(routeHasDomain);
        }
        // Keyed by uid like the rest; the server translates these onto the adopted ROW
        // names via the (now identity-keyed) rename map before publishing.
        if (routes.length) routesByServiceName[uid] = routes;
      }
      // Repo compose services with no running container (built/pulled fresh from
      // the repo): carry their route + env override keyed by the REPO service
      // name. The engine saves their routes against the resulting service rows
      // so they deploy and route like any native service.
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
        serviceContainerIds: picked
          .map((s) => s.containerId)
          .filter((id): id is string => Boolean(id)),
        volumeStrategies,
        gitSource: p.repo
          ? {
              provider: "github" as const,
              owner: p.repo.owner,
              repo: p.repo.repo,
              branch: p.repo.branch,
            }
          : undefined,
        serviceSubpaths: Object.keys(serviceSubpaths).length ? serviceSubpaths : undefined,
        serviceRenames: Object.keys(serviceRenames).length ? serviceRenames : undefined,
        serviceEnv: Object.keys(serviceEnv).length ? serviceEnv : undefined,
        routesByServiceName: Object.keys(routesByServiceName).length
          ? routesByServiceName
          : undefined,
      };
    });
    setQueue(items);
    setQueueIndex(0);
    setCompleted([]);
    void startMigration(items[0]);
  };

  const handleCutover = async (kill: boolean) => {
    if (!migrationId || !confirmToken) return;
    const isCurrent = claimOperation();
    setCutoverBusy(true);
    setError(null);
    try {
      await dockerMigrationApi.confirmCutover(migrationId, confirmToken, kill);
      if (!isCurrent()) return;
      const res = await dockerMigrationApi.getMigration(migrationId);
      if (isCurrent()) setRun(res.run);
    } catch (e) {
      if (isCurrent()) setError(getApiErrorMessage(e, m.adoptFailed));
    } finally {
      if (isCurrent()) setCutoverBusy(false);
    }
  };

  // Advance the queue when the current project's migration succeeds.
  useEffect(() => {
    if (!queue || run?.status !== "succeeded") return;
    // Routes/domains are published SERVER-SIDE now (see toServerRoutes in the
    // migrate payload), so they land even if this effect never runs (wizard
    // unmounted / run opened from the list). Here we only advance the queue.
    setCompleted((prev) => [
      ...prev,
      { name: queue[queueIndex]?.name ?? "", projectId: run.projectId, warning: run.errorMessage },
    ]);
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
  // The detail poll supplies this run's token, even without a serverId prop.
  useEffect(() => {
    if (!visible || !initialRunId || migrationId === initialRunId) return;
    setQueue([{ name: "", serviceNames: [], volumeStrategies: {} }]);
    setQueueIndex(0);
    setCompleted([]);
    setMigrationId(initialRunId);
    setRun(null);
    setConfirmToken(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRunId, ownerKey, visible]);

  // Re-attach after a CLIENT reload: the run is server-side, so if one is in
  // flight for this server, re-find it and re-seed the state the progress
  // screen + poll need (queue placeholder flips `inProgress`; confirmToken is
  // required for the cutover buttons and is never persisted client-side).
  useEffect(() => {
    if (!visible || !serverId || queue || initialRunId) return; // `queue`/`initialRunId` ⇒ already targeting a run
    let live = true;
    const isCurrent = claimOperation();
    void dockerMigrationApi
      .getActive(serverId)
      .then((res) => {
        if (!live || !isCurrent() || !res.run) return;
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
  }, [serverId, ownerKey, visible]);

  /**
   * Publish the run's phase to the PROJECT payload every time it changes.
   *
   * A project's status pill reads `activeMigration` off that payload (API
   * `readActiveMigration`), and the payload is revision-invalidated, not polled — so without
   * this, a project would go on reading "Migrating" after its run succeeded, and would only
   * start reading it at all on the next full page load. This wizard is the one place in the
   * client that watches a run's status, and it does so for EVERY entry point (a project's
   * Advanced tab, the server's Migrations tab, the Library modal) — so one effect here keeps
   * every surface honest instead of each of them polling the migration API.
   *
   * On status CHANGE only: the poll above ticks every 2.5s, and invalidating on each tick
   * would be a refetch storm. A run changes phase a handful of times from start to terminal.
   */
  useEffect(() => {
    const status = run?.status;
    if (!run || !status) return;
    // BOTH projects a run can be about. A duplicate's `projectId` is repointed at the new
    // project once the adopt step mints it, so invalidating only that would leave the SOURCE
    // project — the one whose Advanced tab started the run — reading a phase it has moved on
    // from. The source id is in the start snapshot, the same place the server reads it.
    const snapshot = run.inputSnapshot as { projectMove?: { projectId?: unknown } } | null;
    const source = snapshot?.projectMove?.projectId;
    const ids = [run.projectId, typeof source === "string" ? source : null].filter(
      (id): id is string => Boolean(id),
    );
    for (const id of new Set(ids)) {
      // MODULE-level, not a ref. The guarded side effect refreshes the project, and a refresh
      // can re-render — or, if a consumer ever gates on `isLoading` again, remount — this very
      // component. Per-mount state cannot dedupe an effect that outlives its own mount: the ref
      // reset on every remount and re-fired, which is the loop this replaced. "Phase X of run Y
      // has been published" is a fact about the session, so it is stored like one.
      const key = `${id}:${run.id}:${status}`;
      if (publishedPhases.has(key)) continue;
      publishedPhases.add(key);
      invalidateProjectCaches(id);
    }
  }, [run]);

  // Poll the current run while a migration is in flight; stop once terminal.
  useEffect(() => {
    if (!visible || !migrationId) return;
    if (run && ["succeeded", "failed", "rolled_back"].includes(run.status)) return;
    let live = true;
    const isCurrent = claimOperation();
    let fetching = false;
    const tick = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const res = await dockerMigrationApi.getMigration(migrationId);
        if (live && isCurrent()) {
          setRun(res.run);
          setConfirmToken(res.run.confirmationToken ?? null);
          setProgress(res.progress ?? null);
        }
      } catch {
        /* transient — keep polling */
      } finally {
        fetching = false;
      }
    };
    const iv = setInterval(tick, 2500);
    void tick();
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [migrationId, run?.status, ownerKey, visible]);

  // Live progress SSE — a smooth, real-time transfer bar (the 2.5s poll above is
  // coarse). The poll stays the authoritative run/log source, so a dropped
  // stream degrades to it rather than stalling. Server closes the stream on the
  // terminal event; opening a finished run just gets a snapshot + close.
  useEffect(() => {
    if (!visible || !migrationId) return;
    const isCurrent = claimOperation();
    const stop = dockerMigrationApi.streamMigration(migrationId, {
      onProgress: (u) => {
        if (isCurrent()) setProgress(u);
      },
    });
    return stop;
  }, [migrationId, ownerKey, visible]);

  // Pull the target deploy's logs + per-service status while it's deploying/
  // verifying (live) and once it fails — so the wizard shows the actual reason
  // and log tail inline instead of only a one-line "partial_failure".
  useEffect(() => {
    const depId = run?.deploymentId;
    const live = run?.status === "deploying" || run?.status === "verifying";
    const failedNow = run?.status === "failed" || run?.status === "rolled_back";
    if (!visible || !depId || (!live && !failedNow)) {
      setDeploy(null);
      return;
    }
    let on = true;
    const isCurrent = claimOperation();
    const tick = async () => {
      try {
        const st = await deployApi.getBuildStatus(depId);
        if (!on || !isCurrent()) return;
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
  }, [run?.deploymentId, run?.status, ownerKey, visible]);

  const inProgress = Boolean(queue);
  const admissionBlocked = !!queue && !migrationId && !starting && !!error;
  const failed = admissionBlocked || run?.status === "failed" || run?.status === "rolled_back";
  const admissionRetry = admissionBlocked ? (
    <Button
      onClick={() => void startMigration(queue![queueIndex]!)}
      disabled={!targetSelection.ready}
    >
      {m.tab.retryRun}
    </Button>
  ) : null;
  const cutoverNeedsRetry = run?.status === "cutover" && Boolean(run.errorMessage);
  const cutoverWarning =
    run?.mode === "cross_server" ? m.cutover.warningRestart : m.cutover.warning;
  // Only go near-full-screen once there are RESULTS to show (an adoptable stack
  // or an in-flight migration). The empty prompt, the loading state, and a
  // "nothing found" result all stay a compact, content-sized dialog.
  const expanded = adoptable || hasReimport || inProgress;

  // Wide layout for the scan/select table AND for the deploy phase — once a
  // target deployment exists (deploying/verifying/failed) we mount the native
  // terminal, which needs the full-width shell. Earlier progress phases
  // (adopting/moving_data) have only a short step list → stay compact.
  const wide = expanded && (!inProgress || Boolean(run?.deploymentId));

  // Page and modal share scan options beside their scan controls. Changing
  // coverage re-scans the selected server when results are already shown.
  const setFlat = (next: boolean) => {
    setFlatDocker(next);
    if (selectedId && stack) void handleScan(next);
  };

  const scanOptions = selfHosted ? (
    <DropdownMenu
      trigger={<UiIcon name="settings" className="size-4 text-muted-foreground" />}
      triggerLabel={m.review.scanOptions}
      disabled={scanning}
      actions={[
        {
          id: "projects",
          label: m.review.detectProjects,
          icon: <UiIcon name={flatDocker ? "project" : "check"} className="size-4" />,
          onClick: () => setFlat(false),
        },
        {
          id: "all",
          label: m.review.includeManaged,
          icon: <UiIcon name={flatDocker ? "check" : "server"} className="size-4" />,
          onClick: () => setFlat(true),
        },
      ]}
    />
  ) : null;

  // "← Back to migrations" (tab variant only) — rendered on its own line above
  // the project tabs: it leaves the flow, so it shouldn't share a row with the
  // controls that act inside it.
  const backBtn = onBack ? (
    <button
      type="button"
      onClick={onBack}
      className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <UiIcon name="arrow-left" className="size-4" />
      {m.tab.back}
    </button>
  ) : null;

  // Compact header lives inside the modal shell only; the page route renders its
  // own Jobs-style header above the wizard.
  const modalHeader = (
    <div className="shrink-0 flex items-center justify-between gap-4 px-6 py-4 border-b border-border/60 bg-muted/[0.18]">
      <div className="flex items-center gap-3 min-w-0">
        <div className="size-9 rounded-xl bg-primary/10 ring-1 ring-inset ring-primary/20 flex items-center justify-center shrink-0">
          <UiIcon name="migration" className="size-[18px] text-primary" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground leading-tight">
            {m.wizard.title}
          </h2>
          <p className="text-xs text-muted-foreground truncate max-w-3xl">{m.wizard.intro}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={close}
        aria-label={m.wizard.close}
        className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
      >
        <UiIcon name="close" className="size-5" />
      </button>
    </div>
  );

  const rescanBtn = (
    <button
      type="button"
      onClick={() => handleScan()}
      disabled={!selectedId || scanning}
      title={m.wizard.rescan}
      aria-label={m.wizard.rescan}
      className="p-2.5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {scanning ? (
        <UiIcon name="spinner" className="size-4 animate-spin" />
      ) : (
        <UiIcon name="refresh" className="size-4" />
      )}
    </button>
  );

  const finalStep = step === "plan";
  const canContinue =
    step === "select"
      ? migratable.length > 0
      : step === "source"
        ? !parsingRepo
        : step === "domains"
          ? migratable.length > 0 && unfinishedRoutes.length === 0
          : canMigrate && (sameServer || planReady);
  const stepActions = (
    <div className="flex shrink-0 items-center justify-between gap-2">
      <Button
        variant="ghost"
        onClick={() => (step === "select" ? close() : setStep(steps[stepIndex - 1] ?? "select"))}
      >
        {step !== "select" && <UiIcon name="arrow-left" className="rtl:rotate-180" />}
        {step === "select" ? m.wizard.cancel : m.wizard.steps.back}
      </Button>
      {step === "select" && (
        <div className="flex items-center gap-1">
          {rescanBtn}
          {scanOptions}
        </div>
      )}
      <Button
        onClick={() => (finalStep ? handleMigrate() : setStep(steps[stepIndex + 1] ?? "domains"))}
        disabled={!canContinue}
      >
        {starting ? <UiIcon name="spinner" className="animate-spin" /> : null}
        {finalStep
          ? migratable.length > 1
            ? interpolate(m.wizard.migrateN, { n: String(migratable.length) })
            : m.wizard.migrate
          : m.wizard.steps.next}
        {!starting && <UiIcon name="arrow-right" className="rtl:rotate-180" />}
      </Button>
    </div>
  );

  const projectPicker =
    projects.length > 1 && active ? (
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <CustomSelect
            value={active.id}
            onChange={setActiveId}
            variant="filled"
            triggerClassName="bg-muted/60 hover:bg-muted"
            options={projects.map((project) => ({
              value: project.id,
              label: project.name || m.wizard.projectName,
            }))}
          />
        </div>
        {step === "select" && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={m.wizard.removeProject}
            onClick={() => removeProject(active.id)}
          >
            <UiIcon name="close" />
          </Button>
        )}
      </div>
    ) : null;

  // Page and modal differ only in their outer shell. Preparation has one layout.
  const preparation = (
    <div className="@container/migration space-y-4">
      {backBtn}
      <div className="grid grid-cols-1 items-start gap-6 @[980px]/migration:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {step === "select" && (
            <>
              {!stack && !error && <EmptyHint scanning={scanning} status={scanStatus} />}
              {stack && !adoptable && !hasReimport && <NoResults message={m.discover.nothing} />}
              {stack && (adoptable || hasReimport) && discoveredProjects}
              {error && !stack && <NoResults message={error} isError />}
            </>
          )}
          {step === "source" &&
            active &&
            stack &&
            (active.repo ? (
              <ServiceMapPanel
                project={active}
                stack={stack}
                parsing={parsingRepo === active.id}
                onSetMap={(uid, name) => setServiceMap(active.id, uid, name)}
              />
            ) : github.connected ? (
              <div className="rounded-2xl bg-card p-4">
                <RepositoryList
                  repos={github.repos}
                  accounts={github.accounts}
                  selectedOwner={github.selectedOwner}
                  setSelectedOwner={github.setSelectedOwner}
                  loading={github.loading}
                  loadingRepos={github.loadingRepos}
                  onSelect={(owner, repo) =>
                    void onRepoChange(active.id, {
                      provider: "github",
                      owner,
                      repo: repo.name,
                      branch: repo.default_branch || "main",
                    })
                  }
                  installUrl={github.installUrl}
                  onInstall={() => void github.connect("oauth")}
                  installing={github.connecting}
                />
              </div>
            ) : (
              <div className="flex min-h-[240px] items-center justify-center rounded-2xl bg-card p-8 text-center">
                <p className="max-w-xs text-sm text-muted-foreground">
                  {m.wizard.steps.repoConnectHint}
                </p>
              </div>
            ))}
          {step === "domains" && serviceReviews}
          {step === "plan" && (
            <>
              {targetCard}
              {!sameServer && selectedId && targetId && (
                <TransferPlanSummary
                  sourceId={selectedId}
                  targetId={targetId}
                  serviceNames={planServiceNames}
                  serviceContainerIds={planServiceContainerIds}
                  flatDocker={flatDocker}
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
            </>
          )}
        </div>
        <aside
          className="min-w-0 space-y-4 @[980px]/migration:sticky @[980px]/migration:top-6"
          aria-label={m.review.importDetails}
        >
          {step === "select" && recoveredProject ? (
            <RecoveredProjectReview
              key={`${ownerKey}:${selectedId}:${recoveredProject.projectId}`}
              serverId={selectedId ?? ""}
              project={recoveredProject}
              result={recoveryResults[recoveredProject.projectId]}
              isCurrent={claimOperation()}
              onRecovered={(result) =>
                setRecoveryResults((previous) => ({
                  ...previous,
                  [recoveredProject.projectId]: result,
                }))
              }
              onBack={() => setRecoveryId(null)}
              onOpen={(id) => router.push(`/projects/${id}`)}
            />
          ) : adoptable && active && stack ? (
            <>
              {stepNavigation}
              {projectPicker}
              {step === "select" ? (
                <div className="space-y-4 rounded-2xl bg-card p-5">
                  {projectNameField}
                  <p className="text-xs text-muted-foreground">{m.wizard.steps.repoOnSourceHint}</p>
                </div>
              ) : step === "source" ? (
                <RepoSourceCard
                  key={active.id}
                  project={active}
                  github={github}
                  parsing={parsingRepo === active.id}
                  onRepoChange={(repo) => void onRepoChange(active.id, repo)}
                />
              ) : (
                reviewSummary
              )}
              {stepActions}
            </>
          ) : (
            <div className="space-y-4 rounded-2xl bg-card p-5">
              <h3 className="text-base font-semibold text-foreground">{m.entry.cardTitle}</h3>
              <p className="text-sm text-muted-foreground">
                {hasReimport
                  ? m.reimport.chooseHint
                  : selfHosted
                    ? m.entry.cardDesc
                    : m.sources.importHint}
              </p>
              {!serverId && (
                <ServerSelector
                  migrationSource={!selfHosted}
                  value={selectedId}
                  onSelect={pickServer}
                  disabled={scanning}
                />
              )}
              <div className="flex items-center gap-2">
                <Button
                  className="flex-1"
                  onClick={() => handleScan()}
                  disabled={!selectedId || scanning}
                >
                  <UiIcon
                    name={scanning ? "spinner" : "search"}
                    className={scanning ? "animate-spin" : ""}
                  />
                  {scanning ? m.wizard.scanning : m.wizard.scan}
                </Button>
                {scanOptions}
              </div>
            </div>
          )}
          {stack && <MigrationProxyReview stack={stack} />}
        </aside>
      </div>
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
        {run?.status === "awaiting_cutover" || cutoverNeedsRetry ? (
          <>
            <span className="text-xs text-muted-foreground flex-1 min-w-0">{cutoverWarning}</span>
            <div className="flex items-center gap-2 shrink-0">
              {run?.status === "awaiting_cutover" && (
                <button
                  type="button"
                  onClick={() => handleCutover(false)}
                  disabled={cutoverBusy}
                  className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                >
                  {m.cutover.keep}
                </button>
              )}
              <button
                type="button"
                onClick={() => handleCutover(true)}
                disabled={cutoverBusy}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition-colors disabled:opacity-40"
              >
                {cutoverBusy ? (
                  <UiIcon name="spinner" className="size-4 animate-spin" />
                ) : (
                  <UiIcon name="trash" className="size-4" />
                )}
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
                {anyDomainAssigned && <UiIcon name="arrow-right" className="size-4" />}
                {m.run.openProject}
              </button>
              {!anyDomainAssigned && (
                <button
                  type="button"
                  onClick={openDomains}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all"
                >
                  <UiIcon name="arrow-right" className="size-4" />
                  {m.run.addDomains}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <span />
            <div className="flex items-center gap-2 shrink-0">
              {admissionRetry}
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
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{preparation}</div>
  );

  if (variant === "tab") {
    // Inline Services-tab layout: LEFT = discovered containers (scan controls +
    // project tabs + grid); RIGHT = the connection card until a scan swaps in the
    // stepped migrate config (or the live progress). Reuses every sub-component
    // and all wizard state — same flow as the modal, just laid out for the page.

    // Live migration → two-column run view: LEFT = the full status detail
    // (phase timeline + deploy terminal), RIGHT = a compact "activity" rail that
    // keeps the live status, a clean error, and the actions pinned in view.
    if (inProgress) {
      const queueTotal = queue?.length ?? 1;
      const runText = m.run as Record<string, string>;
      const runStatus = run?.status ?? "queued";
      const awaiting = runStatus === "awaiting_cutover";
      const cutoverAction = awaiting || cutoverNeedsRetry;
      const partial = runStatus === "partial";
      // A run opened from the list can already be terminal-success; treat that
      // as done so the rail shows the result, not a spinner.
      const done = allDone || runStatus === "succeeded";
      const running = !failed && !done && !cutoverAction && !partial;
      const terminal = failed || runStatus === "succeeded"; // deletable record
      const railLabel = admissionBlocked
        ? m.adoptFailed
        : done
          ? queueTotal > 1
            ? interpolate(m.run.allSucceeded, { n: String(queueTotal) })
            : m.run.succeeded
          : cutoverAction
            ? awaiting
              ? m.run.awaiting_cutover
              : runText.cutover
            : partial
              ? m.run.partial
              : (runText[runStatus] ?? m.run.queued);

      const railPanel = (
        <div className="space-y-4">
          {backBtn && <div className="flex">{backBtn}</div>}
          <div className="flex flex-col items-center gap-3 text-center">
            <span
              className={`inline-flex size-12 items-center justify-center rounded-2xl ${
                failed
                  ? "bg-destructive/10 text-destructive"
                  : done || awaiting
                    ? "bg-success-bg text-success"
                    : cutoverNeedsRetry || partial
                      ? "bg-warning-bg text-warning"
                      : "bg-primary/10 text-primary"
              }`}
            >
              {failed ? (
                <UiIcon name="alert-circle" className="size-6" />
              ) : done || awaiting ? (
                <UiIcon name="check-circle" className="size-6" />
              ) : cutoverNeedsRetry || partial ? (
                <UiIcon name="alert-circle" className="size-6" />
              ) : (
                <UiIcon name="spinner" className="size-6 animate-spin" />
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
          {cutoverAction && (
            <p className="text-xs leading-relaxed text-muted-foreground">{cutoverWarning}</p>
          )}

          <div className="space-y-2">
            {admissionRetry}
            {cutoverAction ? (
              <>
                <button
                  type="button"
                  onClick={() => handleCutover(true)}
                  disabled={cutoverBusy}
                  className="inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition-colors disabled:opacity-40"
                >
                  {cutoverBusy ? (
                    <UiIcon name="spinner" className="size-4 animate-spin" />
                  ) : (
                    <UiIcon name="trash" className="size-4" />
                  )}
                  {m.cutover.stopRemove}
                </button>
                {awaiting && (
                  <button
                    type="button"
                    onClick={() => handleCutover(false)}
                    disabled={cutoverBusy}
                    className="w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                  >
                    {m.cutover.keep}
                  </button>
                )}
              </>
            ) : partial ? (
              // Resolve UI (edit/skip + Resume) is in the wide LEFT column.
              <p className="text-xs leading-relaxed text-muted-foreground">
                {m.tab.pendingTitle} →
              </p>
            ) : done ? (
              <>
                {!anyDomainAssigned && (
                  <button
                    type="button"
                    onClick={openDomains}
                    className="inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
                  >
                    <UiIcon name="arrow-right" className="size-4" />
                    {m.run.addDomains}
                  </button>
                )}
                <button
                  type="button"
                  onClick={openProject}
                  className={
                    anyDomainAssigned
                      ? "inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
                      : "w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                  }
                >
                  {anyDomainAssigned && <UiIcon name="arrow-right" className="size-4" />}
                  {m.run.openProject}
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="w-full px-4 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  {m.wizard.close}
                </button>
              </>
            ) : (
              <>
                {failed && run?.deploymentId && (
                  <button
                    type="button"
                    onClick={openDeployLogs}
                    className="w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                  >
                    {m.run.viewDeployLogs}
                  </button>
                )}
                {/* PROJECT run → retry in place, or go back and pick a different target. A
                  scan is not offered because there was never a selection to revisit. */}
                {failed && projectRun && projectMoveSnapshot?.projectId && (
                  <button
                    type="button"
                    onClick={() => void retryProjectRun()}
                    disabled={retrying}
                    className="inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40"
                  >
                    {retrying ? (
                      <UiIcon name="spinner" className="size-4 animate-spin" />
                    ) : (
                      <UiIcon name="refresh" className="size-4" />
                    )}
                    {m.tab.retryRun}
                  </button>
                )}
                {failed && projectRun && onBack && (
                  <button
                    type="button"
                    onClick={onBack}
                    className="w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                  >
                    {m.tab.changeTarget}
                  </button>
                )}
                {/* SCAN-started run → the original edit-&-retry, which re-scans on purpose. */}
                {failed && !projectRun && run?.inputSnapshot && (
                  <button
                    type="button"
                    onClick={editRetry}
                    className="inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
                  >
                    <UiIcon name="refresh" className="size-4" />
                    {m.tab.editRetry}
                  </button>
                )}
                {failed && (run?.targetVolumes?.length ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => void cleanupTarget()}
                    disabled={cleanupBusy}
                    className="inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-danger-border text-sm font-medium text-danger hover:bg-danger-bg transition-colors disabled:opacity-40"
                  >
                    {cleanupBusy ? (
                      <UiIcon name="spinner" className="size-4 animate-spin" />
                    ) : (
                      <UiIcon name="trash" className="size-4" />
                    )}
                    {m.tab.cleanupTarget}
                  </button>
                )}
                <button
                  type="button"
                  onClick={cancelRun}
                  className="w-full px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
                >
                  {failed ? m.wizard.close : m.wizard.cancel}
                </button>
              </>
            )}
          </div>

          {/* Delete this run's record (terminal only; project + data untouched). */}
          {terminal && (
            <div className="border-t border-border/50 pt-3">
              {confirmingDelete ? (
                <div className="space-y-2">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {m.tab.confirmDelete}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={deleteBusy}
                      className="flex-1 px-3 py-2 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                    >
                      {m.tab.close}
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteRun()}
                      disabled={deleteBusy}
                      className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition-colors disabled:opacity-40"
                    >
                      {deleteBusy ? (
                        <UiIcon name="spinner" className="size-4 animate-spin" />
                      ) : (
                        <UiIcon name="trash" className="size-4" />
                      )}
                      {m.tab.delete}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-danger-border text-sm font-medium text-danger hover:bg-danger-bg transition-colors"
                >
                  <UiIcon name="trash" className="size-4" />
                  {m.tab.delete}
                </button>
              )}
            </div>
          )}
        </div>
      );
      return (
        // Splits at 2xl, not lg. This panel renders inside a project's Advanced tab, which
        // already has the page's own 340px sidebar — so at lg the run view became the THIRD
        // column and the deploy terminal wrapped every ~30 characters, which is what made a
        // port-conflict error unreadable. The server's Migrations tab is cramped at that width
        // too; one breakpoint fixes both rather than coupling the layout to the entry point.
        //
        // Stacked, the rail comes FIRST (order) so the status and the actions — Cancel, cutover,
        // retry — stay at the top instead of below a tall log. DOM order is unchanged.
        <div ref={stepTopRef} className="space-y-6">
          {/* 1. STATUS + ACTIONS beside the STEP LIST — the summary, on one line.
                 Two short blocks, so they split at `lg`; the logs below stay full width. */}
          <div className="grid grid-cols-1 items-start gap-6 rounded-2xl border border-border/50 bg-card p-6 lg:grid-cols-[260px_minmax(0,1fr)]">
            {railPanel}
            <div className="min-w-0">
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
          </div>

          {/* Partial run → resolve the paths that didn't move (edit / skip), then Resume. Its own
              container: it is a form, not a status read-out. */}
          {partial && migrationId && (
            <PartialResolution
              runId={migrationId}
              pending={(run?.pendingItems ?? []) as PendingItem[]}
            />
          )}

          {/* 2. THE SESSION LOG — the part an operator scrolls. Nested inside the card that also
                 held the steps, scrolling it fought scrolling the page, and the four-line summary
                 above it scrolled away exactly when it mattered. */}
          {run?.logs && (
            <div className="rounded-2xl border border-border/50 bg-card p-6">
              <MigrationSessionLog run={run} status={runStatus} />
            </div>
          )}

          {/* 3. THE DEPLOY LOGS + terminal — 360px of xterm, and only once there is a deployment
                 that is running, verifying or failed. Full width, which is what it always wanted. */}
          {run?.deploymentId &&
            (failed || runStatus === "deploying" || runStatus === "verifying") && (
              <div className="rounded-2xl border border-border/50 bg-card p-6">
                <MigrationDeployLogs
                  run={run}
                  status={runStatus}
                  failed={failed}
                  deployServices={deploy?.services}
                />
              </div>
            )}
        </div>
      );
    }

    /**
     * Opened from a PROJECT and there is no run to show — so there is nothing to render here.
     *
     * Everything below this point is the scan flow: pick a server, scan it, choose containers,
     * map a repo. A project move has no such step, so falling through would put "Existing
     * services / Flat listing / Scanning existing reverse proxy…" inside a project's Advanced
     * tab and invite the operator to adopt containers from a box they never asked about. That is
     * exactly what a failed run's retry used to do.
     *
     * Reached when a run id stops resolving (deleted record, wrong org) or a retry is between
     * runs. Hand control back to whoever opened this — the project's migration card — instead
     * of inventing a screen for a state that has no meaning here.
     */
    if (origin === "project") {
      return (
        <div className="rounded-2xl border border-border/50 bg-card px-5 py-8 text-center">
          <p className="text-sm text-muted-foreground">{m.tab.empty}</p>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="mt-4 inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              {m.tab.back}
            </button>
          )}
        </div>
      );
    }

    return <div ref={stepTopRef}>{preparation}</div>;
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
      <div className={`@container/migration flex flex-col ${wide ? "h-[95vh]" : "max-h-[86vh]"}`}>
        {modalHeader}
        {body}
      </div>
    </Modal>
  );
}

function EmptyHint({ scanning, status }: { scanning?: boolean; status?: string }) {
  const { t } = useI18n();
  return (
    <div className="overflow-hidden rounded-2xl bg-card">
      <div className="flex flex-col items-center px-6 pb-12 pt-10 text-center">
        {/* The migration illustration — the same one the runs-list empty state
            uses. Pulses during the scan so the body never goes blank. */}
        <MigrationIllustration
          className={`relative mb-7 h-32 w-72 max-w-full ${scanning ? "animate-pulse" : ""}`}
        />
        <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
          {scanning ? status || t.migration.wizard.scanning : t.migration.wizard.intro}
        </p>
      </div>
      {/* Safety guarantee footer — migration COPIES, never moves; nothing is
          deleted unless you explicitly cut over. */}
      <div className="flex items-start gap-2.5 border-t border-border/50 bg-muted/30 px-5 py-4 text-start">
        <UiIcon name="shield-check" className="mt-0.5 size-4 shrink-0 text-success" />
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
          <rect
            x="52"
            y="54"
            width="70"
            height="44"
            rx="6"
            fill="var(--th-sf-02)"
            stroke="var(--th-bd-default)"
            strokeWidth="1.5"
            strokeDasharray="5 5"
          />
          {/* magnifier finding nothing (a dash in the lens) */}
          <circle
            cx="132"
            cy="52"
            r="24"
            fill="var(--th-card-bg)"
            stroke="var(--th-bd-strong)"
            strokeWidth="2"
          />
          <line
            x1="123"
            y1="52"
            x2="141"
            y2="52"
            stroke="var(--th-on-30)"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <line
            x1="150"
            y1="70"
            x2="166"
            y2="86"
            stroke="var(--th-bd-strong)"
            strokeWidth="4"
            strokeLinecap="round"
          />
          {/* decorative dots + sparkle */}
          <circle cx="26" cy="40" r="3" fill="var(--th-on-10)" />
          <circle cx="30" cy="110" r="4.5" fill="var(--th-on-08)" />
          <circle cx="182" cy="106" r="3.5" fill="var(--th-on-10)" />
          <path d="M18 74l1.6-3.2 1.6 3.2-3.2-1.6 3.2 0-3.2 1.6z" fill="var(--th-on-14)" />
        </svg>
      </div>
      <p
        className={`max-w-sm text-sm ${isError ? "text-destructive/90" : "text-muted-foreground"}`}
      >
        {message}
      </p>
    </div>
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
  const repo = project.repo;

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
    <section className="space-y-4 rounded-2xl bg-card p-5" aria-label={s.linkRepo}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-foreground">{s.linkRepo}</h3>
        <span className="text-xs text-muted-foreground">{s.repoOptional}</span>
      </div>
      <p className="text-xs text-muted-foreground">{s.linkRepoDesc}</p>

      {!github.connected ? (
        <Button onClick={() => void github.connect()} className="w-full">
          {s.connectGithub}
        </Button>
      ) : !repo ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{s.repoPasteHint}</p>
          <div className="flex items-center gap-2">
            <Input
              variant="filled"
              aria-label={s.repoUrlPlaceholder}
              value={urlInput}
              onChange={(e) => {
                setUrlInput(e.target.value);
                setUrlError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyUrl();
              }}
              placeholder={s.repoUrlPlaceholder}
              className="flex-1 min-w-0"
            />
            <Button onClick={applyUrl}>{s.repoUrlAdd}</Button>
          </div>
          {urlError && <p className="text-xs text-danger">{urlError}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-xl bg-background px-3 py-2">
            <span className="inline-flex min-w-0 items-center gap-2 truncate text-sm font-medium text-foreground">
              {parsing && (
                <UiIcon
                  name="spinner"
                  className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                />
              )}
              {repo.owner}/{repo.repo}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={s.unlinkRepo}
              title={s.unlinkRepo}
              onClick={() => onRepoChange(null)}
            >
              <UiIcon name="close" className="size-4" />
            </Button>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-foreground">{s.branch}</p>
            <RepositoryBranchSelect
              owner={repo.owner}
              repo={repo.repo}
              value={repo.branch}
              onChange={(val) => onRepoChange({ ...repo, branch: val })}
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
    <section className="@container/source space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-foreground">{s.mapTitle}</h3>
        </div>
        <p className="text-xs text-muted-foreground">{s.mapHint}</p>
      </div>

      {parsing ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <UiIcon name="spinner" className="size-4 animate-spin" /> {s.parsingCompose}
        </div>
      ) : composeNames.length === 0 ? (
        <div className="rounded-2xl bg-card p-4 text-sm text-muted-foreground">
          {s.noComposeFound}
        </div>
      ) : (
        <>
          <div className="rounded-2xl bg-card p-4 space-y-2.5">
            <p className="text-sm font-medium text-muted-foreground">{s.composeServicesTitle}</p>
            <div className="flex flex-wrap gap-1.5">
              {project.composeServices.map((c) => (
                <span
                  key={c.name}
                  className="inline-flex items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1 text-xs text-foreground"
                >
                  {c.name}
                  {c.build ? (
                    <span className="text-xs text-muted-foreground">{c.build}</span>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
          {/* One card per selected container: name on top, full-width service
              dropdown below — readable, no cramped truncation. */}
          <div className="grid grid-cols-1 gap-4 @[640px]/source:grid-cols-2">
            {picked.map((sv) => {
              const uid = svcUid(sv);
              const mapped = project.serviceMap[uid] ?? "";
              return (
                <div key={uid} className="min-w-0 rounded-2xl bg-card p-4 space-y-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <ServiceIcon service={sv} className="size-4 shrink-0" />
                      <span
                        className="truncate text-sm font-medium text-foreground"
                        title={sv.name}
                      >
                        {sv.name}
                      </span>
                    </div>
                    {(sv.image || sv.build) && (
                      <p
                        className="mt-1 truncate text-xs text-muted-foreground"
                        title={sv.image || sv.build}
                      >
                        {sv.image || `${t.migration.discover.build}: ${sv.build}`}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label className="block text-sm font-medium text-muted-foreground">
                        {s.mapField}
                      </label>
                      {Object.keys(sv.env).length > 0 && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {interpolate(t.migration.discover.nEnv, {
                            n: String(Object.keys(sv.env).length),
                          })}
                        </span>
                      )}
                    </div>
                    <CustomSelect
                      variant="filled"
                      triggerClassName="bg-muted/60 hover:bg-muted"
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
  serviceContainerIds,
  flatDocker,
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
  /** Container ids for the same set — resolves the plan by identity (#584). */
  serviceContainerIds?: string[];
  /** The scan mode the selection came from; the plan must be sized in the same mode. */
  flatDocker?: boolean;
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
  const key = `${sourceId}|${targetId}|${[...serviceNames].sort().join(",")}|${[
    ...(serviceContainerIds ?? []),
  ]
    .sort()
    .join(",")}|${flatDocker ? "flat" : "grouped"}|${customPaths
    .map((c) => `${c.source}>${c.dest}`)
    .join(",")}`;

  const [loadedPreview, setLoadedPreview] = useState<{
    key: string;
    preview: MigrationPreview;
  } | null>(() => {
    const preview = cache.current.get(key);
    return preview ? { key, preview } : null;
  });
  // A previous server's successful review cannot authorize this destination.
  const preview = loadedPreview?.key === key ? loadedPreview.preview : null;
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newSrc, setNewSrc] = useState("");
  const [newDst, setNewDst] = useState("");

  useEffect(() => {
    if (!sourceId || !targetId || serviceNames.length === 0) return;
    const cached = cache.current.get(key);
    if (cached) {
      setLoadedPreview({ key, preview: cached });
      setErr(null);
      setLoading(false);
      return; // readiness handled by the effect below (factors conflicts)
    }
    let live = true;
    setLoading(true);
    setErr(null);
    onReady?.(false);
    dockerMigrationApi
      .preview({
        sourceServerId: sourceId,
        targetServerId: targetId,
        serviceNames,
        serviceContainerIds,
        flatDocker,
        customPaths,
      })
      .then((res) => {
        if (!live) return;
        cache.current.set(key, res.preview);
        setLoadedPreview({ key, preview: res.preview });
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
    onReady?.(
      !loading && !!preview && conflicts.every((c) => Boolean(conflictResolution[c.volume])),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, loading, conflictResolution]);

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
  return (
    <div className="space-y-5 rounded-2xl bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-foreground">{plan.title}</h3>
        {loading && <UiIcon name="spinner" className="size-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Target-volume conflicts — must be resolved (override/clone/keep) before
          Migrate. Keyed by the unique VOLUME name so two same-named services stay
          isolated. Gates onReady above; nothing destructive starts unresolved. */}
      {conflicts.length > 0 && (
        <div className="space-y-4 rounded-xl border border-warning-border bg-warning-bg/40 p-4">
          <div className="flex items-center gap-2">
            <UiIcon name="alert-circle" className="size-4 shrink-0 text-warning" />
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
                className={`flex-1 rounded-lg border px-3 py-2 text-start transition-colors ${
                  sel === action
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-muted/40"
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
                    {it.exists === false && (
                      <UiIcon name="alert-circle" className="size-3.5 shrink-0 text-warning" />
                    )}
                    <span className="truncate text-muted-foreground" title={it.ref}>
                      {it.ref}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 tabular-nums ${it.exists === false ? "text-warning" : "text-foreground"}`}
                  >
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
            <UiIcon name="spinner" className="size-4 animate-spin" />
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
                <UiIcon name="check" className="size-4 shrink-0 text-success" />
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
            <span
              className="min-w-0 flex-1 truncate text-muted-foreground"
              title={`${c.source} → ${c.dest}`}
            >
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
          <Input
            variant="filled"
            value={newSrc}
            onChange={(e) => setNewSrc(e.target.value)}
            placeholder={plan.pathSrcPlaceholder}
            aria-label={plan.pathSrcPlaceholder}
            className="min-w-0 flex-1"
          />
          <span className="shrink-0 text-muted-foreground/50">→</span>
          <Input
            variant="filled"
            value={newDst}
            onChange={(e) => setNewDst(e.target.value)}
            placeholder={plan.pathDestPlaceholder}
            aria-label={plan.pathDestPlaceholder}
            className="min-w-0 flex-1"
          />
          <Button onClick={addPath} disabled={!canAdd}>
            {plan.pathAdd}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border/50 pt-4">
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-medium text-muted-foreground">{m.wizard.transfer.label}</p>
          <CustomSelect
            variant="filled"
            triggerClassName="bg-muted/60 hover:bg-muted"
            value={transferMode}
            onChange={setTransferMode}
            options={[
              { value: "", label: m.wizard.transfer.default },
              { value: "stream", label: m.wizard.transfer.stream },
            ]}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <Checkbox checked={compress} onCheckedChange={setCompress} />
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
  completed: Array<{ name: string; projectId?: string | null; warning?: string | null }>;
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
  /**
   * Show per-line times only once the run is OVER.
   *
   * Live, you are watching it happen — "when" is now, and a clock in front of every message is
   * noise. Finished, the timing IS the content: which step took the five seconds, where it
   * stalled, how long the transfer ran. See `session-log-line`.
   */
  const logShowsTime =
    status === "succeeded" ||
    status === "failed" ||
    status === "rolled_back" ||
    status === "partial";
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
  const failed =
    (!run && !!error) ||
    status === "failed" ||
    status === "rolled_back" ||
    (status === "cutover" && Boolean(run?.errorMessage));
  const allDone = completed.length >= queueTotal;

  return (
    <div className="py-2 space-y-5 text-sm">
      {run?.pendingPrompt && <MigrationPrompt run={run} />}
      {run?.errorMessage && !failed && (
        <p role="alert" className="rounded-xl bg-warning/10 p-3 text-sm text-warning">
          {run.errorMessage}
        </p>
      )}
      {completed
        .filter((item) => item.warning && item.projectId !== run?.projectId)
        .map((item, index) => (
          <p
            key={`${item.projectId}-${index}`}
            role="alert"
            className="rounded-xl bg-warning/10 p-3 text-sm text-warning"
          >
            {item.name}: {item.warning}
          </p>
        ))}
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
                {state === "done" && <UiIcon name="check" className="size-3" />}
                {completed[i]?.name ?? (i === queueIndex ? queueName : `#${i + 1}`)}
              </span>
            );
          })}
        </div>
      )}

      {allDone ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-success rounded-xl bg-success-bg px-4 py-3">
            <UiIcon name="check-circle" className="size-5 shrink-0" />
            <span className="font-medium">
              {queueTotal > 1
                ? interpolate(m.run.allSucceeded, { n: String(queueTotal) })
                : m.run.succeeded}
            </span>
          </div>
          {!hasDomains && (
            <p className="px-1 text-xs leading-relaxed text-muted-foreground/80">
              {m.run.routeHint}
            </p>
          )}
        </div>
      ) : failed ? (
        <div className="flex items-start gap-2 text-sm text-destructive rounded-xl bg-destructive/10 px-4 py-3">
          <UiIcon name="alert-circle" className="size-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">{run ? runText[status] : m.adoptFailed}</p>
            {(run?.errorMessage || error) && (
              <p className="mt-1 text-sm">{run?.errorMessage || error}</p>
            )}
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
                    <UiIcon name="check" className="size-3" />
                  ) : state === "active" ? (
                    <UiIcon name="spinner" className="size-3 animate-spin" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-current" />
                  )}
                </span>
                <span className={state === "pending" ? "text-muted-foreground" : "text-foreground"}>
                  {runText[p]}
                </span>
                {p === "moving_data" &&
                  state === "active" &&
                  progress &&
                  progress.movedBytes > 0 && (
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

      {status === "awaiting_cutover" && (
        <div className="flex items-start gap-2 text-sm rounded-xl bg-success-bg text-success px-4 py-3">
          <UiIcon name="check-circle" className="size-4 mt-0.5 shrink-0" />
          <span>{m.run.awaiting_cutover}</span>
        </div>
      )}

      {error && !failed && (
        <div className="flex items-start gap-2 text-sm text-destructive rounded-xl bg-destructive/10 px-4 py-3">
          <UiIcon name="alert-circle" className="size-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Durable orchestration log — the "what happened" for debugging, shown for
          any run with output (live or after the fact). */}
    </div>
  );
}

/**
 * The target deploy's per-service result + its live terminal — its OWN panel.
 *
 * Extracted from `MigrationProgress` so the run view can stack three separate containers
 * (status+steps, session log, deploy logs) instead of one tall card holding all of it. The steps
 * are a four-line summary an operator glances at; a 360px terminal below them in the same box
 * pushed that summary off screen exactly when it mattered.
 *
 * Renders nothing until there is a deployment to show, and only while it is deploying/verifying
 * or after it failed — the states where its output is the thing you came for.
 */
export function MigrationDeployLogs({
  run,
  status,
  failed,
  deployServices,
}: {
  run: MigrationRun | null;
  status: MigrationStatus;
  failed: boolean;
  deployServices?: Array<{ name: string; status: string; error?: string }>;
}) {
  const { t } = useI18n();
  const m = t.migration;
  if (!run?.deploymentId || !(failed || status === "deploying" || status === "verifying"))
    return null;
  return (
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
                {s.error && (
                  <span className="min-w-0 flex-1 truncate text-danger">— {s.error}</span>
                )}
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
  );
}

/**
 * The durable orchestration log — "what happened", for any run with output.
 *
 * Its own panel for the same reason as the deploy logs above, and because it is the one part an
 * operator scrolls: nesting a scroll region inside a card that also holds the step list meant
 * scrolling the log fought scrolling the page.
 */
export function MigrationSessionLog({
  run,
  status,
}: {
  run: MigrationRun | null;
  status: MigrationStatus;
}) {
  const { t } = useI18n();
  const m = t.migration;
  /** Times only once the run is OVER — see `session-log-line`. */
  const logShowsTime =
    status === "succeeded" ||
    status === "failed" ||
    status === "rolled_back" ||
    status === "partial";
  if (!run?.logs) return null;
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{m.tab.sessionLog}</p>
      <div className="max-h-56 overflow-y-auto rounded-xl border border-border/50 bg-muted/20 px-4 py-3 font-mono text-[12px] leading-relaxed text-muted-foreground">
        {parseSessionLog(run.logs).map((line, i) => (
          // Time in its OWN column, and only once the run is over — see `session-log-line`.
          // Inline, the stored `[2026-08-16T21:54:22.358Z] ` prefix took 26 monospace
          // characters in front of every message and wrapped mid-word with the message
          // (`break-all`), which is what made the panel unreadable while a run was live.
          <div key={i} className="flex gap-2.5">
            {logShowsTime && (
              <span
                className="shrink-0 tabular-nums text-muted-foreground/50"
                // The full instant stays one hover away rather than in the way.
                title={line.iso ?? undefined}
              >
                {line.time ?? ""}
              </span>
            )}
            <span className="min-w-0 whitespace-pre-wrap break-words">{line.message}</span>
          </div>
        ))}
      </div>
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
        <UiIcon name="alert-circle" className="size-4 text-warning" />
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
        {busy ? (
          <UiIcon name="spinner" className="size-4 animate-spin" />
        ) : (
          <UiIcon name="refresh" className="size-4" />
        )}
        {busy ? tab.resuming : tab.resume}
      </button>
    </div>
  );
}
