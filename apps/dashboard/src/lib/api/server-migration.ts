import { api, getApiBaseUrl } from "./client";
import { endpoints } from "./endpoints";

// ─── Types (mirror apps/api docker-inspect.service.ts DiscoveredStack) ────────

export interface DiscoveredVolumeMount {
  type: "volume" | "bind";
  source?: string;
  target: string;
  rw: boolean;
}

export interface DiscoveredService {
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
  /** Routes the server's existing (foreign) reverse proxy already serves for this
   *  container, matched by published host port. ONE ENTRY PER (port,path,match mode): a
   *  path-fan-out domain (`/ → :1010`, `/v3 → :1020`) or a multi-port container
   *  collects several. Absent = none detected. */
  existingRoute?: Array<{
    port: number;
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

/**
 * GH-570: an intermediary that buffers `text/event-stream` answers 200 and then
 * delivers nothing. A read on that body neither resolves nor rejects, so the caller
 * waits forever — the reported "spinner spins, wizard never times out". An idle
 * watchdog is the only thing that separates a buffered transport from a genuinely
 * slow scan, and it is safe here precisely BECAUSE the server heartbeats every
 * SYSTEM.SSE.HEARTBEAT_INTERVAL_MS (25s): silence past that is the transport, never
 * the work, however long the work takes.
 */
const SCAN_STREAM_FIRST_BYTE_MS = 15_000;
/** TWO missed 25s heartbeats plus slack. One (50s) is not enough headroom: a single
 *  delayed ping on a loaded box would read as a stall. Being wrong here is cheap —
 *  the fallback is a read-only re-scan — but there's no reason to spend one. */
const SCAN_STREAM_IDLE_MS = 70_000;

/** The stream never delivered, as distinct from the scan having failed. Callers should
 *  retry through the non-streaming `scan()`, which crosses the same hops as any POST. */
export class ScanStreamStalledError extends Error {
  constructor(reason: string) {
    super(`Scan stream unusable (${reason})`);
    this.name = "ScanStreamStalledError";
  }
}

export const isScanStreamStalled = (e: unknown): e is ScanStreamStalledError =>
  e instanceof ScanStreamStalledError;

/**
 * Docker migration API client — talks to /api/migration (self-hosted only).
 * Distinct from `migrationApi` (lib/api/migration.ts), which is the unrelated
 * team-instance/data migration.
 */
export const dockerMigrationApi = {
  /** Read-only: inspect a server's Docker and return the adoptable stack.
   *  SSH connect + `docker inspect` across every container easily exceeds the
   *  client's 15s default (esp. through the same-origin proxy's extra hop under
   *  `openship up`), so give it real headroom like checkServer does. */
  scan: (serverId: string, opts: { flatDocker?: boolean } = {}) =>
    api.post<{ success: boolean; stack: DiscoveredStack }>(
      endpoints.dockerMigration.scan,
      { serverId, flatDocker: opts.flatDocker === true },
      { timeout: 120_000 },
    ),

  /**
   * Streaming inspect (SSE): same result as scan(), but with step progress and no
   * bound on TOTAL duration — a slow SSH + docker inspect is never aborted for
   * merely taking long. What IS bound is silence; see ScanStreamStalledError, and
   * fall back to scan() when it's thrown.
   */
  scanStream: (
    serverId: string,
    opts: { onProgress?: (message: string) => void; flatDocker?: boolean } = {},
  ): Promise<DiscoveredStack> =>
    new Promise((resolve, reject) => {
      void (async () => {
        const url =
          `${getApiBaseUrl()}${endpoints.dockerMigration.scanStream}?serverId=${encodeURIComponent(serverId)}` +
          (opts.flatDocker ? "&flatDocker=1" : "");
        const abort = new AbortController();
        let stallReason: string | null = null;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        // One watchdog covers connect, headers, first byte and mid-stream silence:
        // aborting rejects the fetch AND any in-flight read, so every way the
        // transport can go quiet arrives at the same branch.
        const arm = (ms: number) => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            stallReason = `no data for ${Math.round(ms / 1000)}s`;
            abort.abort();
          }, ms);
        };
        const asError = (e: unknown) =>
          stallReason
            ? new ScanStreamStalledError(stallReason)
            : e instanceof Error
              ? e
              : new Error(String(e));

        arm(SCAN_STREAM_FIRST_BYTE_MS);
        let res: Response;
        try {
          res = await fetch(url, {
            method: "GET",
            credentials: "include",
            headers: { Accept: "text/event-stream" },
            signal: abort.signal,
          });
        } catch (e) {
          clearTimeout(watchdog);
          reject(asError(e));
          return;
        }
        if (!res.ok || !res.body) {
          // Watchdog stays armed across this read: a hop that stalls a stream stalls
          // an error body too, and aborting here just falls back to the status text.
          const detail = await res.text().catch(() => res.statusText);
          clearTimeout(watchdog);
          reject(new Error(detail));
          return;
        }
        // A 200 that isn't an event-stream means something between us and the API
        // answered in its place; the frame loop would read to EOF and find nothing.
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          clearTimeout(watchdog);
          void res.body.cancel().catch(() => {});
          reject(new ScanStreamStalledError(`200 response was "${contentType || "untyped"}"`));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          try { void reader.cancel(); } catch { /* noop */ }
          fn();
        };
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            // Re-arm on the raw chunk, not on a parsed frame: a heartbeat comment and
            // a half-delivered frame both prove the transport is still moving.
            arm(SCAN_STREAM_IDLE_MS);
            buf += decoder.decode(value, { stream: true });
            // Parse whole "…\n\n" frames so a large result payload split across
            // reads is never half-parsed.
            let nl: number;
            while ((nl = buf.indexOf("\n\n")) !== -1) {
              const frame = buf.slice(0, nl);
              buf = buf.slice(nl + 2);
              const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
              if (!dataLine) continue;
              let msg: { type?: string; message?: string; stack?: DiscoveredStack; error?: string };
              try {
                msg = JSON.parse(dataLine.slice(5).trim());
              } catch {
                continue;
              }
              if (msg.type === "progress" && msg.message) opts.onProgress?.(msg.message);
              else if (msg.type === "result" && msg.stack) return finish(() => resolve(msg.stack!));
              else if (msg.type === "error") return finish(() => reject(new Error(msg.error || "Scan failed")));
            }
          }
          clearTimeout(watchdog);
          // Closed with no result: a hop that buffered and flushed only at EOF looks
          // like this too, so it carries the same "retry unstreamed" signal.
          if (!settled) reject(new ScanStreamStalledError("stream ended without a result"));
        } catch (e) {
          clearTimeout(watchdog);
          if (!settled) reject(asError(e));
        }
      })();
    }),

  /** On-demand reveal of the named env keys of ONE discovered container (the scan
   *  masks them). Write-gated (server:write) — same bar as the service-env reveal
   *  (#336); the API rejects an empty `keys`. */
  revealEnv: (input: { serverId: string; containerId: string; keys: string[] }) =>
    api.post<{ success: boolean; environment: Record<string, string> }>(
      endpoints.dockerMigration.revealEnv,
      input,
    ),

  /** Create an Openship project from the selected discovered services (records only). */
  adopt: (input: {
    serverId: string;
    projectName: string;
    serviceNames: string[];
    /** Container ids of the picked services (`svcUid`) — globally unique, unlike a
     *  compose service name, which is only unique within its own stack (#584). */
    serviceContainerIds?: string[];
  }) =>
    api.post<AdoptResult>(endpoints.dockerMigration.adopt, input),

  /** Re-import an orphaned Openship project (DR / cross-instance), preserving its id.
   *  Records only — the user redeploys from the project to finalize live state. */
  reimport: (input: {
    serverId: string;
    projectId: string;
    projectName?: string;
    serviceNames?: string[];
  }) => api.post<ReimportResult>(endpoints.dockerMigration.reimport, input),

  /** Read-only preview of a full migration to a (possibly different) server. */
  preview: (input: {
    sourceServerId: string;
    targetServerId: string;
    serviceNames: string[];
    /** Container ids of the picked services (`svcUid`) — globally unique, unlike a
     *  compose service name, which is only unique within its own stack (#584). */
    serviceContainerIds?: string[];
    /** Must match the scan the plan is derived from (the "Flat listing" toggle). */
    flatDocker?: boolean;
    /** Extra paths to size in the plan (cross-server). */
    customPaths?: CustomPath[];
  }) =>
    api.post<{ success: boolean; preview: MigrationPreview }>(
      endpoints.dockerMigration.preview,
      input,
      { timeout: 120_000 },
    ),

  /** Parse a linked repo's docker-compose (GitHub API, no clone) → its services,
   *  for the map step. Empty list when the repo has no compose file. */
  parseRepoCompose: (owner: string, repo: string, branch?: string) =>
    api.post<{ success: boolean; services: ComposeRepoService[] }>(
      endpoints.dockerMigration.repoCompose,
      { owner, repo, branch },
    ),

  /** Start a full migration. Returns the run id + the cutover confirmation token. */
  migrate: (input: {
    sourceServerId: string;
    targetServerId: string;
    serviceNames: string[];
    /** Container ids of the picked services (`svcUid`) — globally unique, unlike a
     *  compose service name, which is only unique within its own stack (#584). */
    serviceContainerIds?: string[];
    projectName: string;
    killOriginals?: boolean;
    /** Same-server only: serviceName → "reuse" (take over in place) | "copy". */
    volumeStrategies?: Record<string, "reuse" | "copy">;
    /** Per-run override of the volume-transfer strategy (else the user's Settings default). */
    transferMode?: "auto" | "stream" | "direct" | "rsync";
    transferCompression?: "auto" | "zstd" | "gzip" | "none";
    /** Optional project-level git repo to link (records source + push auto-deploy;
     *  the running image is still reused — no rebuild during migrate). */
    gitSource?: { provider: "github"; owner: string; repo: string; branch?: string };
    /** serviceName → build subpath (rootDirectory) inside the linked repo. */
    serviceSubpaths?: Record<string, string>;
    /** discovered serviceName → repo compose service name to adopt the row AS,
     *  so a later git-compose reconcile matches it in place (no duplicate). */
    serviceRenames?: Record<string, string>;
    /** serviceName → env override (edited in the wizard; else discovered env). */
    serviceEnv?: Record<string, Record<string, string>>;
    /** Extra paths to move (cross-server): source host path → target host path. */
    customPaths?: CustomPath[];
    /** serviceName → domain/route to publish server-side once the target is up.
     *  `targetPath` (e.g. "/v3") marks a service serving a PATH of a shared
     *  domain (path fan-out); its absence = the root `/`. */
    routesByServiceName?: Record<
      string,
      {
        exposedPort?: string;
        domainType: "free" | "custom";
        domain?: string;
        customDomain?: string;
        targetPath?: string;
        exact?: boolean;
      }
    >;
    /** serviceName → target-volume conflict resolution (override/clone/keep). */
    conflictResolution?: Record<string, ConflictAction>;
    /** Adopt Openship-managed containers too (raw Docker) — must match the scan. */
    flatDocker?: boolean;
  }) =>
    api.post<{ success: boolean; migrationId: string; confirmationToken: string }>(
      endpoints.dockerMigration.migrate,
      input,
    ),

  /**
   * Start the move. Returns the same `{ migrationId, confirmationToken }` as `migrate`, so
   * the caller opens the ORDINARY run panel by id (`initialRunId`) and confirms the cutover
   * through the ordinary route — there is no project-specific progress UI.
   *
   * No `killOriginals`: a project move always parks at `awaiting_cutover` so the operator's
   * live project can never be retired without an explicit confirmation. The server enforces
   * that; it is not a client courtesy.
   */
  startProjectMove: (input: {
    projectId: string;
    targetServerId: string;
    /**
     * `move` — the project relocates: one project, new host, source retired at cutover.
     * `copy` — the original stays put and a SECOND project appears on the target.
     *
     * Omitted defaults to `move` server-side: the safer reading of a malformed request is
     * the one that doesn't quietly create a project.
     */
    intent?: "move" | "copy";
    /** `copy` only — name for the new project. Defaults to `<name>-copy`, de-duplicated. */
    newName?: string;
    /** `copy` only — duplicate just these services (service-level copy). Omit for all.
     *  A scoped MOVE is refused: a project is bound to one server. */
    serviceNames?: string[];
    transferMode?: "auto" | "stream" | "direct" | "rsync";
    transferCompression?: "auto" | "zstd" | "gzip" | "none";
    /** volumeName → how to resolve a target volume that already holds data. */
    conflictResolution?: Record<string, ConflictAction>;
    customPaths?: CustomPath[];
  }) =>
    api.post<{ success: boolean; migrationId: string; confirmationToken: string }>(
      endpoints.dockerMigration.projectMove,
      input,
    ),

  /** Poll a migration run's current state (+ coarse live transfer progress). */
  getMigration: (id: string) =>
    api.get<{ success: boolean; run: MigrationRun; progress?: TransferProgress | null }>(
      endpoints.dockerMigration.migration(id),
    ),

  /**
   * Live run SSE — the CLEAN real-time feed (like the deploy build stream):
   * byte-level `progress` (smooth bar) + session `log` lines as they happen.
   * Returns a cleanup fn; the run row (status / pendingItems) is still the
   * authoritative source via getMigration, so a dropped stream degrades to the
   * poll rather than stalling. Best-effort — never throws.
   */
  streamMigration: (
    id: string,
    handlers: { onProgress?: (u: TransferProgress) => void; onLog?: (line: string) => void },
  ): (() => void) => {
    const controller = new AbortController();
    void (async () => {
      const url = `${getApiBaseUrl()}${endpoints.dockerMigration.migration(id)}/stream`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
      } catch {
        return;
      }
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            let ev: { type?: string; line?: string } & Partial<TransferProgress>;
            try {
              ev = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            if (ev.type === "progress" && typeof ev.movedBytes === "number") {
              handlers.onProgress?.({
                task: ev.task ?? "",
                kind: ev.kind ?? "volume",
                movedBytes: ev.movedBytes,
                totalBytes: ev.totalBytes ?? null,
              });
            } else if (ev.type === "log" && typeof ev.line === "string") {
              handlers.onLog?.(ev.line);
            }
          }
        }
      } catch {
        /* aborted / dropped — the getMigration poll keeps state fresh */
      }
    })();
    return () => controller.abort();
  },

  /** Confirm (kill=true) or decline (kill=false) the destructive cutover. */
  confirmCutover: (id: string, confirmationToken: string, kill: boolean) =>
    api.post<{ success: boolean }>(endpoints.dockerMigration.cutover(id), {
      confirmationToken,
      kill,
    }),

  /** Abort an in-flight migration (kills the transfer + rolls back on the server). */
  cancel: (id: string) =>
    api.post<{ success: boolean }>(endpoints.dockerMigration.cancel(id), {}),

  /** Delete a terminal run's record (history cleanup; project + data untouched). */
  remove: (id: string) =>
    api.delete<{ success: boolean }>(endpoints.dockerMigration.migration(id)),

  /** Resume a `partial` run: re-transfer the pending paths (per-key source
   *  overrides) and skip the chosen ones; finishes to cutover when none remain. */
  resume: (id: string, body: { overrides?: Record<string, string>; skip?: string[] }) =>
    api.post<{ success: boolean }>(endpoints.dockerMigration.resume(id), body),

  /** Remove the volumes a FAILED run copied to the target (source untouched). */
  cleanupTarget: (id: string) =>
    api.post<{ success: boolean; removed: number }>(endpoints.dockerMigration.cleanupTarget(id), {}),

  /** The in-flight run for a server (or null) — for re-attaching after a reload. */
  getActive: (serverId: string) =>
    api.get<{ success: boolean; run: MigrationRun | null; confirmationToken: string | null }>(
      `${endpoints.dockerMigration.active}?serverId=${encodeURIComponent(serverId)}`,
    ),

  // NO per-project variant of the above. A project's live run reaches the client on the
  // PROJECT payload (`activeMigration`), which is what every surface that renders a project
  // already loads — so the status pill, the page header and the project's own migration panel
  // all read one field instead of each asking this module a question it can only answer while
  // mounted. See `readActiveMigration` (api) and `ProjectStatusSource` (utils/project-status).

  /**
   * Recent runs about a PROJECT (newest first) — its migration history, listed beside the
   * migration card the way deployments are listed on the Deployments tab.
   *
   * Includes a duplicate taken FROM this project as well as runs of the project itself, because
   * both are things that happened to it. Same endpoint and same row shape as the per-server
   * list — one history, two viewpoints.
   */
  listForProject: (projectId: string) =>
    api.get<{ success: boolean; runs: MigrationRun[] }>(
      `${endpoints.dockerMigration.runs}?projectId=${encodeURIComponent(projectId)}`,
    ),

  /** Recent runs for a server (newest first) — the "Migrations" tab list. */
  list: (serverId: string) =>
    api.get<{ success: boolean; runs: MigrationRun[] }>(
      `${endpoints.dockerMigration.runs}?serverId=${encodeURIComponent(serverId)}`,
    ),
};
