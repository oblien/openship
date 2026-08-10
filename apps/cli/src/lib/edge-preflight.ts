/**
 * Host-side edge preflight for `openship up` (Docker Compose self-deploy).
 *
 * The compose stack's OpenResty `edge` container binds host :80/:443 via
 * `network_mode: host` the instant `docker compose up` runs. If another proxy
 * (the user's nginx/caddy/…) already owns those ports, the edge can't bind — so
 * BEFORE bringing the stack up we run the SAME detect → "proxy X serving N
 * sites" → consent → stop chain the dashboard and the bare wizard use. This is
 * the piece `apps/api/src/lib/startup/self-edge.ts` explicitly delegates to
 * `openship up` in docker-edge mode.
 *
 * Detection runs directly against the host via a `LocalExecutor` (the api isn't
 * up yet, so we can't use its /self-edge/preflight endpoint). On "migrate" we
 * ALSO read the foreign cert PEMs here (the container edge can't read the host
 * filesystem) and hand them, with the parsed sites, to the api's
 * `POST /system/edge/import-sites` AFTER the stack is up (done by the caller).
 *
 * Everything is behind an injectable `deps` object so the flow is unit-testable
 * with fakes — no real docker/ss/fs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { isCancel, log, note, select } from "@clack/prompts";
import { OS_DIR } from "./paths";
import {
  LocalExecutor,
  beginEdgeTakeover as realBeginEdgeTakeover,
  completeEdgeTakeover as realCompleteEdgeTakeover,
  foreignProxyOnEdge as realForeignProxyOnEdge,
  importSites as realImportSites,
  detectInstalledProxy as realDetectInstalledProxy,
  scanImportableSites as realScanImportableSites,
  ourEdgeContainerRunning as realOurEdgeContainerRunning,
  recoverInterruptedTakeover as realRecoverInterruptedTakeover,
  rollbackEdgeTakeover as realRollbackEdgeTakeover,
  edgeProxy,
  edgeProxyFor,
  collectProxyCerts,
  unreachableStaticRoots,
  copyStaticRootIntoEdge,
  type CommandExecutor,
  type EdgeStatus,
  type ImportedSite,
  type ProxyKind,
  type UnreachableStaticRoot,
} from "@repo/adapters/proxy";

export type EdgeAction = "migrate" | "takeover" | "cancel";

export interface EdgePlan {
  /** Proceed to `docker compose up`? False = the user cancelled (proxy left running). */
  proceed: boolean;
  /**
   * Why we're not proceeding, when it wasn't the user's choice — currently only
   * "we stopped the proxy and the ports still didn't come free". Without this the
   * caller can't tell a cancel from a failed handover and prints the wrong thing.
   */
  blockedBy?: string;
  /** What the user chose when a foreign proxy was found (absent when the edge was clean). */
  action?: EdgeAction;
  /** Sites parsed from the foreign proxy — passed to the api's import endpoint (migrate). */
  sites?: ImportedSite[];
  /** Foreign cert PEMs read host-side, keyed by hostname (migrate + TLS sites). */
  certPems?: Record<string, { certPem: string; keyPem: string }>;
  /**
   * Corrected static roots (keyed by primary hostname) for adopted static sites
   * whose original docroot the container edge can't reach — the files were copied
   * into the edge's static bind mount host-side. Forwarded to the import endpoint
   * so the route records the reachable root. See #456.
   */
  staticRootOverrides?: Record<string, string>;
}

export interface EdgePreflightDeps {
  platform: NodeJS.Platform;
  /** Whether we can prompt (TTY). Non-interactive falls back to the flag or cancel. */
  interactive: boolean;
  makeExecutor(): CommandExecutor;
  foreignProxyOnEdge(
    executor: CommandExecutor,
  ): Promise<{ status: EdgeStatus; blocked: boolean; owner: string }>;
  importSites(
    executor: CommandExecutor,
    status: EdgeStatus,
  ): Promise<{ sites: ImportedSite[]; warnings: string[] }>;
  /**
   * Journal-then-free: writes the rollback record BEFORE stopping the proxy, then
   * waits for the sockets to be released and reports whether they were. `freed:false`
   * means the handover did not happen, so bringing the stack up would just crash-loop
   * the edge on `bind() … (98: Address already in use)`.
   */
  beginEdgeTakeover(
    executor: CommandExecutor,
    status: EdgeStatus,
    onLog: (message: string, level?: "info" | "warn" | "error") => void,
  ): Promise<{ freed: boolean; stillBound: number[] }>;
  /** Undo a `beginEdgeTakeover` from THIS run. True when something came back up. */
  rollbackHostEdge(): Promise<boolean>;
  /** Restore a proxy stopped by an earlier (crashed) run before we re-probe. */
  recoverInterruptedTakeover(
    executor: CommandExecutor,
    onLog: (message: string, level?: "info" | "warn" | "error") => void,
    isEdgeHealthy?: () => Promise<boolean>,
  ): Promise<void>;
  ourEdgeContainerRunning(executor: CommandExecutor): Promise<boolean>;
  /** A proxy INSTALLED on this host but not holding the ports (we stopped it). */
  detectInstalledProxy(executor: CommandExecutor): Promise<ProxyKind | null>;
  /** Parse one proxy's on-disk config directly — no EdgeStatus/occupant needed. */
  scanProxySites(
    executor: CommandExecutor,
    proxy: ProxyKind,
  ): Promise<{ sites: ImportedSite[]; warnings: string[] }>;
  /** Hostnames our edge already serves (authoritative "already imported" check). */
  edgeServedHostnames(): Set<string>;
  /** Ask whether to import a stopped proxy's remaining sites. Injectable like
   *  `confirm` so the flow stays testable without a TTY. */
  confirmStoppedImport(info: { proxy: ProxyKind; count: number }): Promise<boolean>;
  /**
   * Harvest the source proxy's certs so the containerized API can install them —
   * it can't read the host filesystem itself, which is why the CLI reads them here.
   * Keyed by hostname (and cert path, for a declared-path proxy).
   *
   * Delegates to the adapter's one cert reader, so caddy's data dir and traefik's
   * acme.json are carried too — this used to read declared config paths only, which
   * neither of those proxies has, so every domain on them silently re-issued.
   * Injectable to keep the flow testable without a real proxy on disk.
   */
  collectCerts(
    executor: CommandExecutor,
    sites: ImportedSite[],
    source: { status?: EdgeStatus; proxy?: ProxyKind },
  ): Promise<Record<string, { certPem: string; keyPem: string }>>;
  /** Show the detected conflict (sites + non-migratable warnings) to the operator. */
  render(info: { owner: string; sites: ImportedSite[]; warnings: string[] }): void;
  /** Ask which action to take (interactive path only). */
  confirm(info: { owner: string; known: boolean; importable: number }): Promise<EdgeAction>;
  warn(message: string): void;
}

/**
 * Detect a foreign proxy on :80/:443 and, on consent, stop it so the compose
 * edge container can bind. Returns whether to proceed and (for migrate) the
 * sites + cert PEMs to re-register into the container edge after the stack is up.
 *
 * `edge` is the `--edge` flag value (pre-answers the prompt, e.g. for CI).
 */
export async function planAndApplyHostEdge(
  opts: { edge?: EdgeAction },
  overrides: Partial<EdgePreflightDeps> = {},
): Promise<EdgePlan> {
  const deps: EdgePreflightDeps = { ...defaultDeps(), ...overrides };

  // The host-net edge (and thus the :80/:443 contention) is a Linux concept;
  // Docker Desktop on mac/win has no host networking. Nothing to detect.
  if (deps.platform !== "linux") return { proceed: true };

  const executor = deps.makeExecutor();

  // A previous run may have stopped the operator's proxy and then died (failed
  // image pull, Ctrl-C, crash). Restore it BEFORE probing, so detection sees the
  // host's real state instead of "port free" — unless our edge container is in
  // fact up, in which case that takeover succeeded and only its journal is stale.
  await deps
    .recoverInterruptedTakeover(
      executor,
      (m, l) => deps.warn(l === "info" ? m : chalk.yellow(m)),
      () => deps.ourEdgeContainerRunning(executor),
    )
    .catch(() => {});

  const { status, blocked, owner } = await deps.foreignProxyOnEdge(executor);
  if (!blocked) {
    // Ports are free or already ours — but a proxy we STOPPED on an earlier run
    // may still have its vhosts on disk, unimported. probeEdge can't see it (it
    // holds no ports), so without this its sites are silently stranded: the
    // operator was told they'd be migrated and nothing serves them. Nothing to
    // stop here, so no journal/consent-to-kill — just offer to import.
    return await offerStoppedProxyImport(executor, deps);
  }

  const { sites, warnings } = await deps.importSites(executor, status);

  const action = await resolveAction(opts.edge, { status, owner, sites, warnings }, deps);
  if (action === "cancel") return { proceed: false };

  // migrate captures the foreign certs (host FS) before we stop the proxy;
  // takeover just frees the ports and lets the imported sites drop.
  const certPems =
    action === "migrate" ? await deps.collectCerts(executor, sites, { status }) : undefined;
  // Adopted static sites whose docroot the container edge can't see would 500 after
  // cutover — copy them into the edge's static mount host-side and record the
  // corrected root (both are host ops, done before we stop the proxy). The compose
  // edge is ALWAYS a container, so containerEdge:true here. See #456.
  const staticRootOverrides =
    action === "migrate"
      ? await remediateUnreachableStaticRoots({
          unreachable: unreachableStaticRoots(sites, { containerEdge: true }),
          executor,
          interactive: deps.interactive,
        })
      : undefined;
  // Journaled stop: if the caller's bring-up fails it calls rollbackHostEdge()
  // and the operator's proxy comes back, instead of the box staying dark.
  const freed = await deps.beginEdgeTakeover(executor, status, (m, l) =>
    deps.warn(l === "info" ? m : chalk.yellow(m)),
  );
  // The stop didn't release the ports, so `compose up` would bring up an edge that
  // crash-loops. Stop here and hand the proxy back rather than reporting a handover
  // that didn't happen.
  if (!freed.freed) {
    const plural = freed.stillBound.length > 1;
    const restored = await deps.rollbackHostEdge();
    return {
      proceed: false,
      blockedBy:
        `port${plural ? "s" : ""} ${freed.stillBound.join(" and ")} ${plural ? "are" : "is"} still in use ` +
        `after stopping ${owner}` +
        (restored ? " (the previous proxy has been restored)" : ""),
    };
  }
  return action === "migrate"
    ? { proceed: true, action, sites, certPems, staticRootOverrides }
    : { proceed: true, action };
}

/** What `previewHostEdge` found on :80/:443. */
export interface EdgePreview {
  /** Human label of what holds the ports; null when they're free or already ours. */
  owner: string | null;
  /** A FOREIGN proxy holds them, so `up` would have to migrate or take over. */
  blocked: boolean;
  /** Sites parsed off that proxy — what "migrate" would carry across. */
  sites: ImportedSite[];
  /** Config items that wouldn't migrate automatically. */
  warnings: string[];
}

/**
 * Who holds :80/:443 right now, and what a real `up` would offer to do about it —
 * for `--dry-run`. STRICTLY read-only.
 *
 * Not `planAndApplyHostEdge` with a flag: that flow's first act is
 * `recoverInterruptedTakeover` (it restarts a proxy an earlier crashed run left
 * stopped), and it ends by journaling and STOPPING the occupant. A preview must do
 * neither — it only probes and parses, so it is safe on a box the operator is
 * merely evaluating.
 */
export async function previewHostEdge(
  overrides: Partial<Pick<EdgePreflightDeps, "platform" | "makeExecutor" | "foreignProxyOnEdge" | "importSites">> = {},
): Promise<EdgePreview> {
  const deps = { ...defaultDeps(), ...overrides };
  const empty: EdgePreview = { owner: null, blocked: false, sites: [], warnings: [] };
  // Host networking (and thus the :80/:443 contention) is a Linux concept.
  if (deps.platform !== "linux") return empty;
  try {
    const executor = deps.makeExecutor();
    const { status, blocked, owner } = await deps.foreignProxyOnEdge(executor);
    if (!blocked) return { ...empty, owner: owner || null };
    const { sites, warnings } = await deps.importSites(executor, status);
    return { owner: owner || null, blocked: true, sites, warnings };
  } catch {
    // A probe that can't run (no `ss`, no docker, no permission) must not fail the
    // preview — the rest of the plan is still worth printing.
    return empty;
  }
}

/**
 * Restore the proxy `planAndApplyHostEdge` stopped. Call this on ANY failure
 * between the takeover and a serving edge (compose up failed, API never became
 * healthy) — otherwise 80/443 stay dark with the operator's proxy stopped AND
 * disabled. Returns true if something was actually restored.
 */
export async function rollbackHostEdge(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    return await realRollbackEdgeTakeover(new LocalExecutor(), (entry) =>
      console.log(chalk.yellow(`  ${entry.message}`)),
    );
  } catch {
    return false;
  }
}

/** Marker: sites from a stopped proxy were already imported — don't re-offer. */
const IMPORTED_MARKER = join(OS_DIR, "imported-proxy");

/**
 * Hostnames OUR edge already serves, read from its live vhosts.
 *
 * The authoritative "already imported?" signal. A marker file under OS_DIR is not:
 * `openship-dev` runs with OPENSHIP_HOME=~/.openship-dev, so a marker written by
 * one install is invisible to the other, and wiping ~/.openship (or reinstalling)
 * loses it — either way the operator gets re-asked to import sites that are
 * already live, which reads as the tool having forgotten what it just did.
 *
 * Returns an empty set when the edge isn't up yet (first install) — nothing is
 * served, so everything is genuinely importable.
 */
function edgeServedHostnames(): Set<string> {
  const served = new Set<string>();
  const r = spawnSync(
    "docker",
    [
      "exec",
      "openship-edge",
      "sh",
      "-c",
      "cat /usr/local/openresty/nginx/conf/sites-enabled/*.conf 2>/dev/null || true",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !r.stdout) return served;
  for (const m of r.stdout.matchAll(/server_name\s+([^;]+);/g)) {
    for (const host of m[1].trim().split(/\s+/)) {
      if (host && host !== "_") served.add(host.toLowerCase());
    }
  }
  return served;
}

/** Record that a stopped proxy's sites were imported, so re-runs don't duplicate. */
export function markStoppedProxyImported(): void {
  try {
    mkdirSync(OS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(IMPORTED_MARKER, new Date().toISOString(), { mode: 0o600 });
  } catch {
    /* best-effort — worst case we offer again and the operator declines */
  }
}

/**
 * The ports are free/ours, but an installed-yet-stopped proxy may still hold
 * unimported vhosts (we stopped it on a previous run). Offer to bring them in.
 * Interactive only: on a headless run we don't guess at re-importing sites.
 */
async function offerStoppedProxyImport(
  executor: CommandExecutor,
  deps: EdgePreflightDeps,
): Promise<EdgePlan> {
  if (!deps.interactive || existsSync(IMPORTED_MARKER)) return { proceed: true };

  let proxy: ProxyKind | null = null;
  try {
    proxy = await deps.detectInstalledProxy(executor);
  } catch {
    return { proceed: true };
  }
  if (!proxy) return { proceed: true };

  // Scan the proxy's config DIRECTLY. The `importSites(executor, status)` entry
  // derives the proxy from a live occupant, which by definition doesn't exist
  // here — faking an EdgeStatus to satisfy it would be a lie the type system
  // can't check.
  let sites: ImportedSite[] = [];
  let warnings: string[] = [];
  try {
    const scan = await deps.scanProxySites(executor, proxy);
    sites = scan.sites;
    warnings = scan.warnings;
  } catch {
    return { proceed: true };
  }
  if (sites.length === 0) return { proceed: true };

  // Drop anything our edge ALREADY serves, so a re-run doesn't offer to re-import
  // sites that are live. A site counts as done when every hostname it answers to
  // is present in the edge's vhosts.
  const served = deps.edgeServedHostnames();
  const pending = sites.filter(
    (site) => !site.serverNames.every((h) => served.has(h.trim().toLowerCase())),
  );
  if (pending.length === 0) return { proceed: true };
  sites = pending;

  deps.render({ owner: `${proxy} (stopped)`, sites, warnings });
  if (!(await deps.confirmStoppedImport({ proxy, count: sites.length }))) {
    return { proceed: true };
  }

  return {
    proceed: true,
    action: "migrate",
    sites,
    certPems: await deps.collectCerts(executor, sites, { proxy }),
  };
}

/* ── Doctor: "the edge container can't bind" diagnosis + repair ───────────── */

export interface EdgeDiagnosis {
  /** Our edge container exists in some state (running, restarting, exited). */
  containerExists: boolean;
  /** …and is actually running. */
  containerRunning: boolean;
  /** Human label of whatever holds :80/:443, or null when the ports are free. */
  occupant: string | null;
  /**
   * The occupant is a competing OPENRESTY/proxy on the HOST while our edge is
   * containerized — a deprecated bare edge, or someone's own nginx. Detect used to
   * miss the first case by marking a host OpenResty "ours", so `foreignProxyOnEdge`
   * reported blocked=false, nothing stopped it, and it squatted :80/:443 forever
   * while the edge container crash-looped on `bind() … Address already in use`.
   * A host OpenResty is now an ordinary migration source, so this reports it.
   */
  hostProxySquatting: boolean;
  /** Sites parsed off the occupant, when it's an importable proxy. */
  sites: ImportedSite[];
  /** True when the container is up AND nothing else holds the ports. */
  healthy: boolean;
}

function dockerState(name: string): { exists: boolean; running: boolean } {
  const r = spawnSync(
    "docker",
    ["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.State}}"],
    { encoding: "utf8" },
  );
  const state = (r.stdout ?? "").trim();
  return { exists: state.length > 0, running: state === "running" };
}

/**
 * Why isn't the containerized edge serving? Answers the question `openship doctor`
 * needs, without changing anything.
 */
export async function diagnoseEdge(): Promise<EdgeDiagnosis> {
  const empty: EdgeDiagnosis = {
    containerExists: false,
    containerRunning: false,
    occupant: null,
    hostProxySquatting: false,
    sites: [],
    healthy: false,
  };
  if (process.platform !== "linux") return empty;

  const { exists, running } = dockerState("openship-edge");
  const executor = new LocalExecutor();
  let status: EdgeStatus | undefined;
  let owner: string | null = null;
  try {
    const probe = await realForeignProxyOnEdge(executor);
    status = probe.status;
    owner = probe.owner || null;
  } catch {
    return { ...empty, containerExists: exists, containerRunning: running };
  }

  // Occupants that are NOT our edge container: a host process (systemd unit or a
  // bare pid) or some other container. If our container is meant to own these
  // ports, anything else here is what's blocking it.
  const foreignOccupants = status.occupants.filter((o) => o.containerName !== "openship-edge");
  const hostProxySquatting =
    !running && foreignOccupants.some((o) => !o.containerName);

  let sites: ImportedSite[] = [];
  if (status.occupants.length > 0) {
    try {
      sites = (await realImportSites(executor, status)).sites;
    } catch {
      /* best-effort — a non-importable occupant just has no sites */
    }
  }

  return {
    containerExists: exists,
    containerRunning: running,
    occupant: foreignOccupants.length > 0 ? owner : null,
    hostProxySquatting,
    sites,
    healthy: running && foreignOccupants.length === 0,
  };
}

/**
 * Free :80/:443 for the edge container and bring it up.
 *
 * `migrate` imports the occupant's sites into our edge first; `stop` just frees
 * the ports (the occupant's sites stop being served). Both go through the SAME
 * journaled stop as `openship up`, so an interrupted repair is restorable, and
 * both reuse the api's import endpoint rather than reimplementing registration.
 */
export async function repairEdgeConflict(
  mode: "migrate" | "stop",
  apiPort: string,
  onLog: (message: string, level?: "info" | "warn" | "error") => void,
): Promise<{ ok: boolean; registered: string[]; detail: string }> {
  if (process.platform !== "linux") {
    return { ok: false, registered: [], detail: "the containerized edge is Linux-only" };
  }
  const executor = new LocalExecutor();
  const { status, owner } = await realForeignProxyOnEdge(executor);
  if (status.occupants.length === 0) {
    spawnSync("docker", ["restart", "openship-edge"], { stdio: "ignore" });
    return { ok: true, registered: [], detail: "ports were already free — restarted the edge" };
  }

  const scan = mode === "migrate" ? await realImportSites(executor, status) : { sites: [], warnings: [] };
  const certPems =
    mode === "migrate" ? await collectCertsFromProxy(executor, scan.sites, { status }) : undefined;

  // Journaled: if the edge still won't come up, rollbackHostEdge() restores this.
  const freed = await realBeginEdgeTakeover(executor, status, (entry) =>
    onLog(entry.message, entry.level),
  );
  // A stop that didn't release the socket means the edge will just crash-loop again
  // and we'd report "freed :80/:443" for a box that is still dark. Put the occupant
  // back instead — the journal is exactly what that's for.
  if (!freed.freed) {
    const restored = await rollbackHostEdge();
    return {
      ok: false,
      registered: [],
      detail:
        `port${freed.stillBound.length > 1 ? "s" : ""} ${freed.stillBound.join(" and ")} still in use ` +
        `after stopping ${owner || "the existing proxy"}` +
        (restored ? " — the previous proxy has been restored" : " — and the restore did NOT bring it back"),
    };
  }
  spawnSync("docker", ["restart", "openship-edge"], { stdio: "ignore" });

  if (mode === "migrate" && scan.sites.length > 0) {
    const { importMigratedSites } = await import("./edge-import");
    const outcome = await importMigratedSites(apiPort, scan.sites, certPems);
    if (outcome.registered.length === 0) {
      return {
        ok: false,
        registered: [],
        detail: `freed the ports but registered none of the ${scan.sites.length} site(s) — journal kept so the old proxy can be restored`,
      };
    }
    await completeHostEdge();
    return {
      ok: true,
      registered: outcome.registered,
      detail: `migrated ${outcome.registered.length}/${scan.sites.length} site(s) and restarted the edge`,
    };
  }

  await completeHostEdge();
  return { ok: true, registered: [], detail: "freed :80/:443 and restarted the edge" };
}

/**
 * Mark the takeover finished once the edge is actually serving, so the next run's
 * recovery doesn't mistake it for an interrupted one and restart the old proxy.
 */
export async function completeHostEdge(): Promise<void> {
  if (process.platform !== "linux") return;
  try {
    await realCompleteEdgeTakeover(new LocalExecutor());
  } catch {
    /* best-effort — a stale journal only costs one recovery probe next run */
  }
}

async function resolveAction(
  flag: EdgeAction | undefined,
  ctx: { status: EdgeStatus; owner: string; sites: ImportedSite[]; warnings: string[] },
  deps: EdgePreflightDeps,
): Promise<EdgeAction> {
  if (flag) return flag;
  if (!deps.interactive) {
    deps.warn(
      `An existing proxy (${ctx.owner}) holds :80/:443 and this is a non-interactive run. ` +
        `Re-run with --edge=migrate (import its sites), --edge=takeover (stop it, sites drop), ` +
        `or --edge=cancel. Leaving it running.`,
    );
    return "cancel";
  }
  deps.render({ owner: ctx.owner, sites: ctx.sites, warnings: ctx.warnings });
  return deps.confirm({
    owner: ctx.owner,
    known: ctx.status.classification === "known",
    importable: ctx.sites.length,
  });
}

async function collectCertsFromProxy(
  executor: CommandExecutor,
  sites: ImportedSite[],
  source: { status?: EdgeStatus; proxy?: ProxyKind },
): Promise<Record<string, { certPem: string; keyPem: string }>> {
  const api = source.proxy
    ? edgeProxyFor(executor, source.proxy)
    : await edgeProxy(executor, source.status ? { status: source.status } : {});
  if (!api) return {};
  const { certPems, warnings } = await collectProxyCerts(api, sites);
  for (const w of warnings) console.log(chalk.yellow(`  ${w}`));
  return certPems;
}

/**
 * Show a detected foreign-proxy edge conflict — the sites it serves + any
 * non-migratable warnings. THE one presenter for the migrate/take-over decision,
 * shared by the compose host-edge preflight (defaultDeps), the stopped-proxy
 * import path, and the bare wizard's self-edge preflight (no more copies).
 */
export function renderEdgeConflict(info: { owner: string; sites: ImportedSite[]; warnings: string[] }): void {
  const { owner, sites, warnings } = info;
  if (sites.length > 0) {
    const lines = sites.map((st) => {
      const host = (st.serverNames ?? []).join(", ") || "(no server_name)";
      const dest = st.target.kind === "static" ? `static: ${st.target.root}` : st.target.url;
      return `${chalk.bold(host)} → ${chalk.dim(dest)}${st.ssl ? chalk.green(" [TLS]") : ""}`;
    });
    note(lines.join("\n"), `Detected ${sites.length} site${sites.length === 1 ? "" : "s"} on ${owner}`);
  }
  if (warnings.length > 0) {
    log.warn(`${warnings.length} config item${warnings.length === 1 ? "" : "s"} won't migrate automatically:`);
    for (const w of warnings.slice(0, 8)) log.message(chalk.dim(`• ${w}`));
  }
}

/** Ask migrate / take over / cancel for a foreign proxy on 80/443. The single
 *  EdgeAction prompt — one vocabulary, one default rule — shared by every caller. */
export async function confirmEdgeAction(info: {
  owner: string;
  known: boolean;
  importable: number;
}): Promise<EdgeAction> {
  const { owner, known, importable } = info;
  const choice = await select({
    message: known
      ? `An existing reverse proxy (${owner}) is serving ports 80/443.`
      : `Ports 80/443 are in use by ${owner}, which we couldn't identify.`,
    options: [
      ...(importable > 0
        ? [
            {
              value: "migrate" as const,
              label: `Migrate ${importable} site${importable === 1 ? "" : "s"} & take over`,
              hint: "import the existing sites into Openship's edge, then take 80/443",
            },
          ]
        : []),
      {
        value: "takeover" as const,
        label: "Stop it & take over 80/443",
        hint: known ? "the existing sites stop being served" : "may interrupt a running service",
      },
      { value: "cancel" as const, label: "Cancel — leave it running" },
    ],
    // Default to MIGRATE whenever there are sites we can import: it's the only
    // option that both gets Openship onto 80/443 and keeps the operator's
    // existing sites served, so it's the choice they almost always want and
    // the one that loses nothing on a reflexive Enter.
    // With nothing importable there's no safe default: a known proxy falls
    // back to cancel (blind Enter would stop sites that are being served),
    // and an unidentified port holder to takeover.
    initialValue: importable > 0 ? "migrate" : known ? "cancel" : "takeover",
  });
  return isCancel(choice) ? "cancel" : (choice as EdgeAction);
}

/**
 * Adopted static sites whose docroot the containerized edge can't see would 500
 * after cutover (try_files can't find the index in a directory that isn't
 * mounted). Before the handover, list them and — on Copy — snapshot each tree
 * into the edge's static bind mount HOST-SIDE, returning `{ primaryHost:
 * correctedRoot }` for the server to substitute into the route. THE one
 * remediation presenter, shared by the compose preflight and the bare wizard
 * (#456).
 *
 * Takes the already-computed `unreachable` list rather than recomputing: the
 * compose edge is ALWAYS a container (so its caller computes with
 * `containerEdge:true`), but the bare wizard's edge may be container OR bare, and
 * only the server's preflight knows which — passing the list keeps that
 * determination authoritative instead of hardcoding it here.
 *
 * Batch (not per-site): a 15-site migrate shouldn't ask 15 times. Returns
 * undefined when nothing is unreachable or the operator chose Leave (the sites
 * migrate at their original root and 500 — their explicit choice). A copy that
 * fails for one site drops it from the map (left as-is) with a warning rather
 * than aborting the whole migrate. Non-interactive defaults to Copy — Leave would
 * silently 500, the exact failure #456 is about.
 */
export async function remediateUnreachableStaticRoots(opts: {
  unreachable: UnreachableStaticRoot[];
  executor: CommandExecutor;
  interactive: boolean;
}): Promise<Record<string, string> | undefined> {
  const { unreachable } = opts;
  if (unreachable.length === 0) return undefined;

  note(
    unreachable.map((u) => `${chalk.bold(u.host)} → ${chalk.dim(u.root)}`).join("\n"),
    `${unreachable.length} static site${unreachable.length === 1 ? "" : "s"} rooted outside the edge`,
  );
  log.warn("Their files live outside the edge container's mounts, so they'd return 500 after cutover.");

  let copy = true;
  if (opts.interactive) {
    const choice = await select({
      message: "Copy these sites' files into the edge so they keep serving?",
      options: [
        {
          value: "copy" as const,
          label: `Copy ${unreachable.length === 1 ? "it" : "all"} into the edge`,
          hint: "snapshot the files under /opt/openship/static (recommended)",
        },
        {
          value: "leave" as const,
          label: "Leave as-is",
          hint: "they stop serving until you mount their directory yourself",
        },
      ],
      initialValue: "copy",
    });
    copy = !isCancel(choice) && choice === "copy";
  } else {
    log.info("Non-interactive: copying unreachable static roots into the edge.");
  }
  if (!copy) return undefined;

  const overrides: Record<string, string> = {};
  for (const u of unreachable) {
    try {
      const newRoot = await copyStaticRootIntoEdge(opts.executor, { root: u.root, host: u.host });
      overrides[u.host] = newRoot;
      log.success(`Copied ${u.host} → ${newRoot}`);
    } catch (err) {
      log.warn(
        `Couldn't copy ${u.host} (${u.root}) — it will migrate as-is: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function defaultDeps(): EdgePreflightDeps {
  return {
    platform: process.platform,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    makeExecutor: () => new LocalExecutor(),
    foreignProxyOnEdge: realForeignProxyOnEdge,
    importSites: realImportSites,
    beginEdgeTakeover: (executor, status, onLog) =>
      realBeginEdgeTakeover(executor, status, (entry) => onLog(entry.message, entry.level)),
    rollbackHostEdge,
    recoverInterruptedTakeover: (executor, onLog, isEdgeHealthy) =>
      realRecoverInterruptedTakeover(
        executor,
        (entry) => onLog(entry.message, entry.level),
        isEdgeHealthy,
      ),
    ourEdgeContainerRunning: realOurEdgeContainerRunning,
    detectInstalledProxy: realDetectInstalledProxy,
    scanProxySites: realScanImportableSites,
    edgeServedHostnames,
    confirmStoppedImport: async ({ proxy, count }) => {
      const take = await select({
        message: `${proxy} is stopped but still has ${count} site(s) not served by Openship — import them?`,
        options: [
          { value: "import", label: `Import ${count} site(s)`, hint: "serve them from Openship's edge" },
          { value: "skip", label: "Skip", hint: "leave them unserved" },
        ],
        initialValue: "import",
      });
      return !isCancel(take) && take === "import";
    },
    collectCerts: collectCertsFromProxy,
    render: renderEdgeConflict,
    confirm: confirmEdgeAction,
    warn: (message) => console.log(chalk.yellow(`  ${message}`)),
  };
}
