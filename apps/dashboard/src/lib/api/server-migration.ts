import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { api, getApiBaseUrl } from "./client";
import { endpoints } from "./endpoints";
import type { MigrationServiceRoutes, MigrationSourceInput, ServerDetail } from "@repo/contracts";

// Public migration result types are shared with the CLI and SDK.
import type { DiscoveredVolumeMount, DiscoveredService, ComposeRepoService, DiscoveredGroup, OpenshipProjectGroup, DiscoveredStack, ReimportResult, AdoptResult, MigrationPreviewService, SizedItem, CustomPath, MigrationPreview, ConflictAction, MigrationStatus, PendingItem, MigrationRun, TransferProgress } from "@repo/contracts";
export type { DiscoveredVolumeMount, DiscoveredService, ComposeRepoService, DiscoveredGroup, OpenshipProjectGroup, DiscoveredStack, ReimportResult, AdoptResult, MigrationPreviewService, SizedItem, CustomPath, MigrationPreview, ConflictAction, MigrationStatus, PendingItem, MigrationRun, TransferProgress } from "@repo/contracts";

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
  listSources: () => api.get<{ sources: ServerDetail[] }>(endpoints.dockerMigration.sources),
  createSource: (input: MigrationSourceInput) => api.post<{ server: ServerDetail }>(endpoints.dockerMigration.sources, input, { timeout: 45_000 }).then(result => result.server),
  testSource: (input: MigrationSourceInput) => api.post<{ ok: boolean; message: string; fingerprint: string }>(endpoints.dockerMigration.testSource, input, { timeout: 45_000 }),
  deleteSource: (id: string) => api.delete<{ success: boolean }>(endpoints.dockerMigration.source(id)),
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
          observeCaughtError(e, "dashboard/lib/api/server-migration");
          clearTimeout(watchdog);
          reject(asError(e));
          return;
        }
        if (!res.ok || !res.body) {
          // Watchdog stays armed across this read: a hop that stalls a stream stalls
          // an error body too, and aborting here just falls back to the status text.
          const detail = await res.text().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "dashboard/lib/api/server-migration"); return res.statusText; });
          clearTimeout(watchdog);
          reject(new Error(detail));
          return;
        }
        // A 200 that isn't an event-stream means something between us and the API
        // answered in its place; the frame loop would read to EOF and find nothing.
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          clearTimeout(watchdog);
          void res.body.cancel().catch((diagnosticFailure) => {
            observeCaughtError(diagnosticFailure, "dashboard/lib/api/server-migration");
          });
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
          try { void reader.cancel(); } catch (diagnosticFailure) {
            observeCaughtError(diagnosticFailure, "dashboard/lib/api/server-migration"); /* noop */ }
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
          observeCaughtError(e, "dashboard/lib/api/server-migration");
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
    routesByServiceName?: MigrationServiceRoutes;
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

  respond: (id: string, promptId: string, action: string) =>
    api.post<{ success: boolean }>(endpoints.dockerMigration.respond(id), { promptId, action }),

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
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/lib/api/server-migration");
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
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/lib/api/server-migration");
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
