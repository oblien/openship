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
  ports: string[];
  env: Record<string, string>;
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
  /** A route the server's existing (foreign) reverse proxy already serves for
   *  this container, matched by published host port. Absent = none detected. */
  existingRoute?: {
    domains: string[];
    ssl: { enabled: boolean; certPath?: string; keyPath?: string };
    source?: string;
  };
  warnings: string[];
}

/** A service parsed from a LINKED repo's docker-compose (the map-step reference). */
export interface ComposeRepoService {
  name: string;
  build?: string;
  dockerfile?: string;
  image?: string;
  ports: string[];
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

export interface MigrationPreview {
  sameServer: boolean;
  services: MigrationPreviewService[];
  volumesToMove: string[];
  hasBlocked: boolean;
  downtimeWarning: boolean;
  /** Reverse proxies that won't be imported (Openship's edge replaces them). */
  droppedProxies: string[];
  warnings: string[];
}

export type MigrationStatus =
  | "queued"
  | "adopting"
  | "moving_data"
  | "deploying"
  | "verifying"
  | "awaiting_cutover"
  | "cutover"
  | "succeeded"
  | "failed"
  | "rolled_back";

export interface MigrationRun {
  id: string;
  status: MigrationStatus;
  mode: "cross_server" | "same_server";
  projectId?: string | null;
  deploymentId?: string | null;
  bytesMoved?: number | null;
  errorMessage?: string | null;
}

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
   * Streaming inspect (SSE): same result as scan(), but step-progress events +
   * NO fixed client timeout — the stream stays alive via heartbeats, so a slow
   * SSH + docker inspect (esp. through the same-origin proxy hop) can't be
   * aborted mid-flight. Resolves with the stack; rejects on the error frame.
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
        let res: Response;
        try {
          res = await fetch(url, {
            method: "GET",
            credentials: "include",
            headers: { Accept: "text/event-stream" },
          });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        if (!res.ok || !res.body) {
          reject(new Error(await res.text().catch(() => res.statusText)));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          try { void reader.cancel(); } catch { /* noop */ }
          fn();
        };
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
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
          if (!settled) reject(new Error("Scan stream ended without a result"));
        } catch (e) {
          if (!settled) reject(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    }),

  /** Create an Openship project from the selected discovered services (records only). */
  adopt: (input: { serverId: string; projectName: string; serviceNames: string[] }) =>
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
    /** serviceName → env override (edited in the wizard; else discovered env). */
    serviceEnv?: Record<string, Record<string, string>>;
    /** Adopt Openship-managed containers too (raw Docker) — must match the scan. */
    flatDocker?: boolean;
  }) =>
    api.post<{ success: boolean; migrationId: string; confirmationToken: string }>(
      endpoints.dockerMigration.migrate,
      input,
    ),

  /** Poll a migration run's current state. */
  getMigration: (id: string) =>
    api.get<{ success: boolean; run: MigrationRun }>(
      endpoints.dockerMigration.migration(id),
    ),

  /** Confirm (kill=true) or decline (kill=false) the destructive cutover. */
  confirmCutover: (id: string, confirmationToken: string, kill: boolean) =>
    api.post<{ success: boolean }>(endpoints.dockerMigration.cutover(id), {
      confirmationToken,
      kill,
    }),
};
