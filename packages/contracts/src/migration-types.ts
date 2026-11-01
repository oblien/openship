import type { PromptPayload, ComposeGpuConfig } from "@repo/core";

// ─── Types (mirror apps/api docker-inspect.service.ts DiscoveredStack) ────────

export interface DiscoveredVolumeMount {
  type: "volume" | "bind";
  source?: string;
  target: string;
  rw: boolean;
}

export interface DiscoveredService {
  /** Live GPU settings; an empty object explicitly clears stale declarations. */
  gpu?: ComposeGpuConfig;
  gpuImportError?: string;
  shmSize?: number;
  name: string;
  source: "compose" | "container";
  containerId?: string;
  containerName?: string;
  running: boolean;
  image?: string;
  build?: string;
  dockerfile?: string;
  buildArgs?: Record<string, string | null>;
  ports: string[];
  env: Record<string, string>;
  /** Env that provably came from the IMAGE, not the operator (recovered from
   *  Docker's create-time merge order). Not imported — the same image re-supplies
   *  it — but carried with values so the card can show what was left behind and
   *  offer a one-click import. Absent when nothing was left behind. */
  envImageDefaults?: Record<string, string>;
  volumes: DiscoveredVolumeMount[];
  networks: string[];
  dependsOn: string[];
  command?: string;
  restart?: string;
  /** Set when this container IS the edge proxy (80/443) — dropped from import;
   *  Openship's OpenResty replaces it. */
  proxyKind?: "nginx" | "caddy" | "apache" | "traefik" | "haproxy" | "openresty";
  /** Host edge ports (80/443) it publishes — reserved for Openship's edge. */
  edgePorts?: number[];
  /** Live cpu/memory caps and the Docker swap setting, preserved on adoption. */
  resources?: { cpuCores?: number; memoryMb?: number; swapDisabled?: boolean };
  /** Routes the server's existing (foreign) reverse proxy already serves for this
   *  container, matched by published host port. ONE ENTRY PER (port,path,match mode): a
   *  path-fan-out domain (`/ → :1010`, `/v3 → :1020`) or a multi-port container
   *  collects several. Absent = none detected. */
  existingRoute?: Array<{
    port: number;
    containerPort?: number;
    upstream?: string;
    path: string;
    exact?: boolean;
    domains: string[];
    ssl: { enabled: boolean; certPath?: string; keyPath?: string };
    source?: string;
  }>;
  warnings: string[];
}

/** A service parsed from a LINKED repo's docker-compose (the map-step reference).
 *  Carries env + deps so a repo service with no running container renders as a
 *  full native service card in the wizard, not just a chip. */
export interface ComposeRepoService {
  name: string;
  build?: string;
  dockerfile?: string;
  buildArgs?: Record<string, string | null>;
  image?: string;
  ports: string[];
  environment: Record<string, string>;
  dependsOn: string[];
}

export interface DiscoveredGroup {
  /** compose project name, or null for hand-run standalone containers. */
  project: string | null;
  services: DiscoveredService[];
}

/** An Openship project recovered from the server (see api docker-reconcile.ts). */
export interface OpenshipProjectGroup {
  projectId: string;
  suggestedName: string;
  slug?: string;
  domains?: string[];
  source?: {
    gitProvider?: string | null;
    gitOwner?: string | null;
    gitRepo?: string | null;
    gitBranch?: string | null;
  };
  runtimeMode?: string | null;
  /** true = already exists in this instance's DB (not re-importable, just counted). */
  knownHere: boolean;
  /** A full recovery snapshot exists → re-import restores it faithfully. */
  hasSnapshot: boolean;
  deploymentId?: string;
  /** When last deployed (manifest updatedAt) — a "last seen" hint. */
  updatedAt?: string;
  services: DiscoveredService[];
}

export interface DiscoveredStack {
  serverId: string;
  proxy?: {
    kind: NonNullable<DiscoveredService["proxyKind"]>;
    container: string | null;
    ours: boolean;
  };
  composeProjects: string[];
  groups: DiscoveredGroup[];
  services: DiscoveredService[];
  volumes: Array<{ name: string; driver: string; inUseBy: string[] }>;
  networks: Array<{ name: string; driver: string }>;
  warnings: string[];
  adoptable: boolean;
  /** Live containers already managed by a project in this instance's DB (count). */
  alreadyManaged: number;
  /** Openship projects found on the server; `knownHere: false` are re-importable. */
  openshipProjects: OpenshipProjectGroup[];
  /** Every route the foreign proxy serves, flattened (one per port+path) — for
   *  the route review. Unmatched ones (no adopted service on that port) also
   *  appear in `warnings`. */
  proxyRoutes?: Array<{
    port: number;
    path: string;
    domains: string[];
    ssl: { enabled: boolean; certPath?: string; keyPath?: string };
    source?: string;
  }>;
}

export interface ReimportResult {
  success: boolean;
  projectId: string;
  slug: string;
  reimported: string[];
  /** Reconstructed/restored deployment id when the project came back live. */
  deploymentId?: string;
  /** True when the running containers were re-attached (project is immediately live). */
  reattached: boolean;
  /** True when restored faithfully from the server's full subgraph snapshot. */
  restored?: boolean;
}

export interface AdoptResult {
  success: boolean;
  projectId: string;
  slug: string;
  created: boolean;
  adopted: string[];
}

// ─── Full migration (adopt → move → deploy → verify → cutover) ────────────────

export interface MigrationPreviewService {
  name: string;
  source: "compose" | "container";
  image?: string;
  classification: "registry" | "build";
  blocked: boolean;
  reason?: string;
  /** This service IS the edge proxy → dropped from import. */
  edgeProxy?: boolean;
  /** Non-proxy service whose 80/443 host bindings are stripped (reserved). */
  edgePortsReserved?: number[];
  volumes: Array<{ name: string; target: string }>;
  /** App-data bind paths that WILL be copied to the target. */
  bindMounts: string[];
  /** System/socket bind paths left on the source host. */
  bindMountsSkipped: string[];
  warnings: string[];
}

/** One measured item in the transfer plan. */
export interface SizedItem {
  ref: string;
  kind: "volume" | "bind" | "image" | "path";
  /** Apparent bytes, or null when unmeasurable (timeout / missing). */
  bytes: number | null;
  /** Source existence + type for a bind/custom path (undefined for volume/image).
   *  `exists:false` → the plan warns; the run would park `partial` for it. */
  exists?: boolean;
  type?: "dir" | "file";
}

/** A user-selected extra path to move: source (on source host) → dest (on target). */
export interface CustomPath {
  source: string;
  dest: string;
}

export interface MigrationPreview {
  sameServer: boolean;
  services: MigrationPreviewService[];
  volumesToMove: string[];
  hasBlocked: boolean;
  downtimeWarning: boolean;
  /** Reverse proxies that won't be imported (Openship's edge replaces them). */
  droppedProxies: string[];
  warnings: string[];
  /** Cross-server transfer plan (payload sizes). Absent for same-server.
   *  `partial` = a size couldn't be measured, so `totalBytes` is a lower bound. */
  plan?: {
    totalBytes: number;
    partial: boolean;
    items: SizedItem[];
  };
  /** Per kept domain: whether the source cert will be CARRIED (reused, no ACME)
   *  or re-issued on publish. Cross-server only. */
  sslByDomain?: Array<{ domain: string; hasCert: boolean }>;
  /** Cross-server: each target VOLUME that already holds data (unique per
   *  volume name — two services can share a display name). The user resolves
   *  each (override/clone/keep) at the plan step before migrating. */
  conflicts?: Array<{ serviceName: string; volume: string }>;
}

/** Per-VOLUME resolution for a target-volume conflict (keyed by volume name). */
export type ConflictAction = "override" | "clone" | "keep";

export type MigrationStatus =
  | "queued"
  | "adopting"
  | "moving_data"
  | "deploying"
  | "verifying"
  | "awaiting_cutover"
  | "cutover"
  | "partial"
  | "succeeded"
  | "failed"
  | "rolled_back";

/** A data path that didn't transfer — a `partial` run's resolvable to-do item. */
export interface PendingItem {
  key: string;
  kind: "volume" | "bind" | "path";
  source: string;
  dest?: string;
  serviceName?: string;
  reason: "missing" | "denied" | "error";
  message?: string;
}

export interface MigrationRun {
  id: string;
  /** Returned by the detail endpoint so a reopened run can confirm its own cutover. */
  confirmationToken?: string | null;
  pendingPrompt?: PromptPayload | null;
  status: MigrationStatus;
  /**
   * How the run was started. The first two come from a SCAN (adopt someone else's stack);
   * the `project_*` pair from a project this instance already owns — a move relocates it, a
   * copy leaves it running and builds a second one on the target. Both of those are
   * cross-server by construction, so anything keying off `same_server` treats them
   * correctly by falling through.
   */
  mode: "cross_server" | "same_server" | "project_move" | "project_copy";
  projectName?: string | null;
  projectId?: string | null;
  deploymentId?: string | null;
  bytesMoved?: number | null;
  errorMessage?: string | null;
  /** Durable session log (newline-joined) for the run detail view. */
  logs?: string | null;
  sourceServerId?: string | null;
  targetServerId?: string | null;
  serviceNames?: string[];
  startedAt?: string | null;
  finishedAt?: string | null;
  /** `partial` run's unresolved paths (edit/skip → resume). */
  pendingItems?: PendingItem[];
  /** Volumes a run wrote to the target — a FAILED run can offer to remove these
   *  (they're orphaned after rollback) so a retry starts clean. */
  targetVolumes?: string[];
  /** Snapshot of the start input — drives a failed run's edit-&-retry re-seed
   *  (detail fetch only; stripped from the list). */
  inputSnapshot?: Record<string, unknown> | null;
}

/** Live data-move progress during `moving_data` (in-memory, coarse per-poll).
 *  `movedBytes` is the aggregate across all tasks; `totalBytes` the scanned
 *  payload size (null when unknown — relay path — so the UI shows bytes, not a
 *  %). `task`/`kind` label the current unit. */
export interface TransferProgress {
  task: string;
  kind: "image" | "volume";
  movedBytes: number;
  totalBytes: number | null;
}
