/**
 * Edge preflight — who owns ports 80/443 before we install OpenResty.
 *
 * Both install paths (CLI self-install and dashboard/SSH server setup) run this
 * over a CommandExecutor (local or SSH) before binding the edge ports, so we
 * never silently take down someone's existing reverse proxy. Detection is
 * read-only; acting on the result requires an explicit, user-accepted EdgePolicy.
 */

import { AppError } from "@repo/core";
import type { CommandExecutor } from "../../types";
import {
  describeProcess as probeProcess,
  probeListeningPort,
  type PortOccupant,
} from "../../runtime/port-conflict";
import { OPENRESTY_LUA_DIR } from "../../infra/openresty-lua";
import type {
  SystemLog,
  EdgeOccupant,
  EdgePolicy,
  EdgeStatus,
  EdgeStopTarget,
  ImportedSite,
  ProxyKind,
} from "../types";

const EDGE_PORTS = [80, 443] as const;

/** Thrown when a foreign owner holds 80/443 and no policy authorizes takeover. */
export class EdgeConflictError extends AppError {
  constructor(public readonly status: EdgeStatus) {
    super(
      `Ports ${status.occupants.map((o) => o.port).join("/") || "80/443"} are in use by ` +
        `another service (${status.classification}). Accept a migrate or takeover to continue.`,
      409,
      "EDGE_CONFLICT",
    );
    this.name = "EdgeConflictError";
  }
}

/**
 * Signal (not an error condition): the user chose to MIGRATE the existing
 * proxy's sites rather than just take over. Thrown out of the OpenResty install
 * so the caller can run the full takeover-with-import orchestration
 * (`runEdgeTakeover`) with the sites already scanned here.
 */
export class EdgeMigrateRequested extends Error {
  constructor(
    public readonly status: EdgeStatus,
    public readonly sites: ImportedSite[],
    public readonly warnings: string[] = [],
  ) {
    super("Edge migration requested by user");
    this.name = "EdgeMigrateRequested";
  }
}

async function tryExec(executor: CommandExecutor, command: string): Promise<string | null> {
  try {
    return await executor.exec(command);
  } catch {
    return null;
  }
}

/** Classify a proxy from an image/command/unit string. Exported so the Docker
 *  migration scan can flag a containerized reverse proxy (traefik/nginx/…). */
export function classifyProxy(text: string | undefined): ProxyKind | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (t.includes("openresty")) return "openresty";
  if (/(^|[\s/:])nginx/.test(t)) return "nginx";
  if (/(^|[\s/:])caddy/.test(t)) return "caddy";
  if (/(apache2|httpd)/.test(t)) return "apache";
  if (/(^|[\s/:])traefik/.test(t)) return "traefik";
  if (/(^|[\s/:])haproxy/.test(t)) return "haproxy";
  return undefined;
}

/** Single-quote a value for safe shell interpolation. */
export function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The edge we ship as a container: compose service `edge`, published image
 * `…/openship-edge`, default container name `openship-edge`. Recognized by name
 * OR image so a host-networked OR bridged edge container counts as OUR edge —
 * not a foreign proxy to take over. Matching the `openship-edge` image name is
 * the stable signal (the container name is configurable via OPENSHIP_EDGE_CONTAINER).
 */
export function isOurEdgeContainer(name?: string, image?: string): boolean {
  return /openship-edge/i.test(`${name ?? ""} ${image ?? ""}`);
}

/**
 * Make carried vhosts safe to `include` inside the edge image.
 *
 * The image's own nginx.conf includes `sites-enabled/*.conf` and THEN declares the
 * catch-all (`listen 80 default_server; server_name _;`) that proxies ACME
 * http-01 to certbot and 404s unmanaged hosts. A bare host edge has its own
 * equivalent, so a blind `cp -a` hands the container two default servers for
 * 0.0.0.0:80 — `[emerg] a duplicate default server`, which crash-loops the
 * container. The operator then sees only Docker's "container is restarting"
 * message, and the box gets rolled back to the bare edge it was trying to leave.
 *
 * Two rules, both because the IMAGE owns the catch-all role:
 *   - a conf with no real `server_name` (catch-all only) is dropped — keeping it
 *     would also shadow the image's ACME location, breaking issuance;
 *   - `default_server` is stripped from every remaining `listen`, so a real vhost
 *     that happened to carry the flag stops claiming a role it doesn't need.
 *
 * Runs before EVERY edge start, not only after a carry. A conf left by an older or
 * failed attempt lives in the HOST bind mount, so it poisons every later start —
 * including compose, which never carried anything. That is how one bad conversion
 * became `[emerg] duplicate default server` on every subsequent `openship up`.
 *
 * Best-effort: a box where this can't run is no worse off than before, and
 * `openresty -t` is still the gate that catches a bad tree.
 */
function vhostLog(message: string, level: SystemLog["level"] = "info"): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

export async function sanitizeEdgeVhosts(
  executor: CommandExecutor,
  sitesDir: string,
  onLog: (l: SystemLog) => void,
): Promise<void> {
  // POSIX sh, one pass, no per-file round trips (this runs over SSH).
  const script = [
    `for f in ${sq(sitesDir)}/*.conf; do`,
    // A host-side vhost may be a symlink into /etc/nginx/sites-available. That
    // target is deliberately not mounted in the edge container, so leaving the
    // link here makes nginx's include glob fail at startup. Materialize valid
    // links before the container mounts this directory; remove dangling ones.
    `  [ -e "$f" ] || [ -L "$f" ] || continue;`,
    `  if [ -L "$f" ]; then`,
    `    if [ ! -e "$f" ]; then`,
    `      echo "dropped-dangling-link $f"; rm -f "$f"; continue;`,
    `    fi;`,
    `    if cat "$f" > "$f.osh-link"; then`,
    `      rm -f "$f"; mv "$f.osh-link" "$f"; echo "materialized-link $f";`,
    `    else`,
    `      rm -f "$f.osh-link"; echo "dropped-unreadable-link $f"; rm -f "$f"; continue;`,
    `    fi;`,
    `  fi;`,
    // A real server_name is anything that isn't the `_` wildcard.
    `  if ! grep -qE '^[[:space:]]*server_name[[:space:]]+[^_;[:space:]]' "$f"; then`,
    `    echo "dropped-catchall $f"; rm -f "$f"; continue;`,
    `  fi;`,
    `  if grep -qE '[[:space:]]default_server' "$f"; then`,
    `    sed -E 's/([[:space:]]listen[^;]*)[[:space:]]+default_server/\\1/g' "$f" > "$f.osh" && mv "$f.osh" "$f" && echo "unset-default $f";`,
    `  fi;`,
    `done`,
  ].join(" ");
  const out = await executor.exec(script).catch(() => "");
  for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [action, file] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];
    if (action === "dropped-catchall") {
      onLog(vhostLog(`Dropped catch-all vhost ${file} — the edge image provides it.`, "warn"));
    } else if (action === "unset-default") {
      onLog(vhostLog(`Removed default_server from ${file} — the edge image owns it.`, "warn"));
    } else if (action === "materialized-link") {
      onLog(vhostLog(`Materialized linked edge vhost ${file} for the container mount.`, "warn"));
    } else if (action === "dropped-dangling-link") {
      onLog(vhostLog(`Dropped dangling edge vhost link ${file}.`, "warn"));
    } else if (action === "dropped-unreadable-link") {
      onLog(vhostLog(`Dropped unreadable edge vhost link ${file}.`, "warn"));
    }
  }
}

/**
 * Is our edge DEFINITIVELY broken — crash-looping, exited, dead?
 *
 * Asks the negative on purpose, and answers "no" when it can't tell. The caller acts
 * on `true` by stopping our edge and restoring the operator's proxy, so a false
 * positive TAKES DOWN A WORKING EDGE. The previous version probed `wget` inside the
 * container (no guarantee the image has it; host networking makes 127.0.0.1
 * ambiguous), false-negatived a box serving live traffic, and reported it as dark —
 * the guard became the outage.
 *
 * `.State.Status` can't be misread: `restarting` for a crash loop, `exited` for dead.
 * Anything else — including an unreadable answer — is treated as fine, so the worst
 * case is missing a broken edge (which the next step reports anyway).
 */
export async function edgeIsBroken(executor: CommandExecutor): Promise<boolean> {
  const status = await tryExec(
    executor,
    `docker inspect -f '{{.State.Status}}' ${sq(EDGE_CONTAINER_NAME)} 2>/dev/null`,
  );
  const state = (status ?? "").trim();
  return state === "restarting" || state === "exited" || state === "dead";
}

/**
 * Why the edge container isn't running, from its own log on the box `executor`
 * reaches. Parsing is {@link edgeFailureReason}, so every caller agrees on the cause.
 */
export async function edgeCrashReason(executor: CommandExecutor): Promise<string | null> {
  const logs = await tryExec(
    executor,
    `docker logs --tail 40 ${sq(EDGE_CONTAINER_NAME)} 2>&1`,
  );
  return logs ? edgeFailureReason(logs) : null;
}

/**
 * The one line of an edge container's log that explains why it isn't running.
 *
 * nginx reports a fatal config problem as `[emerg]` — that line IS the diagnosis,
 * and the surrounding 40 lines are startup noise. Returns null when there is no
 * `[emerg]`: the log of a running edge is access lines, and quoting one of those as
 * "the reason" is how a healthy box got reported as broken.
 *
 * Pure string work, deliberately: the two callers read the log through completely
 * different channels (the CLI shells out locally, the installer execs over SSH),
 * and only the PARSING is common. Keeping it in one place stops those two from
 * disagreeing about what counts as the cause.
 */
export function edgeFailureReason(containerLog: string): string | null {
  const lines = containerLog
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const emerg = lines.find((l) => l.includes("[emerg]"));
  if (emerg) return emerg.replace(/^.*\[emerg\]\s*\d*#\d*:\s*/, "");
  // No `[emerg]` → nothing here explains a failure. Do NOT fall back to the last
  // line: on a RUNNING edge that's an access-log entry, and reporting
  // `"GET /favicon.ico" 404` as the reason it's down is worse than silence.
  return null;
}

/**
 * OUR edge container's default name. Lives here (the lean detect module) rather
 * than next to the installer, so the takeover journal — which deliberately imports
 * nothing heavier than this file — can name the container it has to stop before
 * restoring a foreign proxy.
 */
export const EDGE_CONTAINER_NAME = "openship-edge";

/**
 * Is OUR edge CONTAINER running? `openship-edge` by NAME (the default) or by
 * IMAGE (covers a container renamed via OPENSHIP_EDGE_CONTAINER). A running edge
 * container OWNS 80/443 — host-networked (no `--filter publish` match; its Lua
 * lives inside the container, so a host `test -f` misses it) or bridged. This is
 * the SELF-TAKEOVER LOCK: a running edge container alone proves the edge is
 * ours, independent of how the host renders the listening process (the host may
 * show `nginx: master process nginx -g daemon off;` with no `openresty` prefix,
 * and `readlink /proc/<pid>/exe` can be denied). Never let our own edge read as
 * a foreign proxy the takeover flow would kill.
 */
export async function ourEdgeContainerRunning(executor: CommandExecutor): Promise<boolean> {
  return Boolean(await resolveOurEdgeContainer(executor));
}

/**
 * Short-lived memo for {@link resolveOurEdgeContainer}, keyed by the executor —
 * i.e. by the BOX being asked, since an executor reaches exactly one machine.
 *
 * The probe is 1–2 `docker ps` shell-outs (over SSH for a remote server), and it
 * sits on read paths that run constantly: every `createPlatform`, every
 * `checkEdge`, and once per file in `readEdgeFile` /
 * `writeEdgeFile` — so carrying one cert cost eight round-trips to answer the same
 * question. Uncached, this reproduced the per-poll shell-out storm that made the
 * server page slow in the first place.
 *
 * Cache lifetime is deliberately short, and every code path that CREATES or
 * REMOVES the edge invalidates explicitly (see `invalidateEdgeContainer`), so a
 * stale answer can only ever come from someone changing the edge out-of-band —
 * where being wrong for a few seconds costs a retryable reload, not data.
 */
const EDGE_CONTAINER_TTL_MS = 20_000;

interface EdgeContainerMemo {
  value: string | null;
  at: number;
  generation: number;
}

const edgeContainerMemo = new WeakMap<CommandExecutor, EdgeContainerMemo>();
/** Bumped by a no-arg invalidate; makes every existing entry unreadable at once
 *  (a WeakMap can't be enumerated, so there's nothing to delete). */
let edgeMemoGeneration = 0;

/**
 * Drop the memoized edge-container answer. MUST be called by anything that starts,
 * replaces or removes the edge container — otherwise the next reader can be told
 * the old story for up to {@link EDGE_CONTAINER_TTL_MS}.
 *
 * With an executor: only that box. Without: every box (used when we can't name the
 * executor that changed, e.g. a compose stack coming up underneath us).
 */
export function invalidateEdgeContainer(executor?: CommandExecutor): void {
  if (executor) edgeContainerMemo.delete(executor);
  else edgeMemoGeneration++;
}

/**
 * The NAME of our running edge container on this box, or null.
 *
 * Same detection as {@link ourEdgeContainerRunning} — it's the same probe, so
 * this is the single source of truth and the boolean delegates here. Callers that
 * need to reach INTO the edge (`docker exec`) must use this rather than
 * `OPENSHIP_EDGE_CONTAINER`: that env names the CONTROL PLANE's own edge, which
 * says nothing about a remote server we're scanning or deploying to.
 *
 * Memoized per executor for a few seconds. Pass `{ fresh: true }` on paths that
 * are ABOUT TO ACT on the answer (install, uninstall, takeover) — there, a stale
 * negative would create a second edge and a stale positive would skip creating one.
 */
export async function resolveOurEdgeContainer(
  executor: CommandExecutor,
  opts?: { fresh?: boolean },
): Promise<string | null> {
  if (!opts?.fresh) {
    const hit = edgeContainerMemo.get(executor);
    if (hit && hit.generation === edgeMemoGeneration && Date.now() - hit.at < EDGE_CONTAINER_TTL_MS) {
      return hit.value;
    }
  }

  const resolved = await probeOurEdgeContainer(executor);
  edgeContainerMemo.set(executor, {
    value: resolved,
    at: Date.now(),
    generation: edgeMemoGeneration,
  });
  return resolved;
}

async function probeOurEdgeContainer(executor: CommandExecutor): Promise<string | null> {
  const byName = await tryExec(
    executor,
    `docker ps --filter name=openship-edge --format '{{.Names}}' 2>/dev/null | head -1`,
  );
  if (byName?.trim()) return byName.trim();

  // Renamed container (OPENSHIP_EDGE_CONTAINER): still ours if it runs our image.
  const all = await tryExec(executor, `docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null`);
  if (!all) return null;
  for (const line of all.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [name, image] = line.split("\t");
    if (name && isOurEdgeContainer(name, image)) return name;
  }
  return null;
}

/**
 * Is our OpenResty Lua deployed on the HOST filesystem — i.e. is OUR BARE-HOST
 * edge present? Deliberately distinct from `ourEdgeContainerRunning`: callers on
 * the bare-install path (stop-then-reinstall a host OpenResty) must key on THIS,
 * not on a running container — a host `pkill -f openresty` would also hit a
 * host-networked container's process and kill our own containerized edge.
 * `probeEdge` also uses the two signals separately for the bare-host regression
 * guard (stale Lua + a foreign nginx must NOT read as ours).
 */
export async function ourLuaOnHost(executor: CommandExecutor): Promise<boolean> {
  const lua = await tryExec(
    executor,
    `test -f ${OPENRESTY_LUA_DIR}/site_logger.lua && echo ok`,
  );
  return Boolean(lua && lua.includes("ok"));
}

async function detectDockerOnPort(
  executor: CommandExecutor,
  port: number,
): Promise<{ name: string; image: string } | null> {
  const out = await tryExec(
    executor,
    `docker ps --filter publish=${port} --format '{{.Names}}\t{{.Image}}' 2>/dev/null | head -1`,
  );
  const line = out?.trim();
  if (!line) return null;
  const [name, image] = line.split("\t");
  if (!name) return null;
  return { name, image: image ?? "" };
}

/**
 * Is the process listening on the edge port actually OUR OpenResty (vs a foreign
 * system nginx that shares the "nginx" process name)? Confirm the real binary —
 * OpenResty resolves under an `openresty` prefix, a distro nginx under /usr/sbin.
 * Prefer the ps args we already have; fall back to the /proc exe symlink.
 */
async function listenerIsOurOpenResty(
  executor: CommandExecutor,
  listener: { pid?: number | null; rawCommand?: string; command?: string } | null,
): Promise<boolean> {
  if (!listener) return false;
  if (/openresty/i.test(`${listener.rawCommand ?? ""} ${listener.command ?? ""}`)) return true;
  if (listener.pid) {
    const exe = await tryExec(executor, `readlink -f /proc/${listener.pid}/exe 2>/dev/null || true`);
    if (exe && /openresty/i.test(exe)) return true;
  }
  return false;
}

/** `nginx: worker process` / `openresty: worker process …` (the child that shows
 *  up in `ss` because it inherited the listening fd). */
const WORKER_RE = /\b(?:nginx|openresty)\s*:\s*worker process/i;
const MASTER_RE = /\b(?:nginx|openresty)\s*:\s*master process/i;

/**
 * `ss` reports whichever nginx process holds the listening fd — usually a WORKER,
 * because workers inherit it from the master. Stopping a worker frees nothing:
 * the master still owns :80/:443 and immediately respawns it, so the takeover
 * "succeeds" and the edge then fails to bind (the hekai symptom). Walk one hop up
 * to the master when the listener is a worker, and re-resolve the systemd unit
 * from the master's own cgroup.
 *
 * Deliberately narrow: only a worker→master hop, only when the parent really is
 * the matching master. Never a blind PPid walk — that would climb to systemd
 * (PID 1) for a service-started process.
 */
async function resolveProxyMaster(
  executor: CommandExecutor,
  listener: PortOccupant | null,
): Promise<PortOccupant | null> {
  if (!listener?.pid) return listener;
  if (!WORKER_RE.test(`${listener.rawCommand ?? ""} ${listener.command ?? ""}`)) return listener;

  const ppidRaw = await tryExec(
    executor,
    `awk '/^PPid:/{print $2}' /proc/${listener.pid}/status 2>/dev/null || true`,
  );
  const ppid = Number.parseInt((ppidRaw ?? "").trim(), 10);
  if (!Number.isInteger(ppid) || ppid <= 1) return listener;

  const master = await probeProcess(executor, ppid);
  if (!master || !MASTER_RE.test(`${master.rawCommand ?? ""} ${master.command ?? ""}`)) {
    return listener;
  }
  return master;
}

async function probeEdgePort(
  executor: CommandExecutor,
  port: number,
  ours: { containerRunning: boolean; luaOnHost: boolean },
): Promise<EdgeOccupant | null> {
  const listener = await resolveProxyMaster(executor, await probeListeningPort(executor, port));
  const docker = await detectDockerOnPort(executor, port);
  if (!listener && !docker) return null;

  const proxy = classifyProxy(
    [
      docker?.image,
      docker?.name,
      listener?.rawCommand,
      listener?.command,
      listener?.systemdUnit,
    ]
      .filter(Boolean)
      .join(" "),
  );

  // A DIFFERENT docker container publishing this port is genuinely foreign — our
  // edge can't co-bind with it, so `containerRunning` must not claim it.
  const foreignDockerProxy = Boolean(docker) && !isOurEdgeContainer(docker?.name, docker?.image);

  // "Ours" has three shapes:
  //   - OUR edge CONTAINER publishes this port (bridged `openship-edge`) — the
  //     docker occupant IS our edge image/name.
  //   - our edge CONTAINER is RUNNING (host-networked → no docker publish match;
  //     its Lua lives inside the container). A running edge container OWNS
  //     80/443, so the host-process occupant here IS its OpenResty — mark it ours
  //     WITHOUT depending on the listener's binary path (the host may render the
  //     master as `nginx: master process nginx …` with no `openresty` prefix, and
  //     `readlink /proc/<pid>/exe` can be denied). THIS is the self-takeover lock:
  //     our own edge must never read as foreign and get killed by the takeover.
  //   - BARE host: our Lua is on disk AND the process ACTUALLY LISTENING resolves
  //     under an `openresty` prefix — the strict check that keeps a distro
  //     /usr/sbin/nginx from being claimed as ours just because stale Lua remains
  //     (the hekai regression).
  const managedByOpenship =
    isOurEdgeContainer(docker?.name, docker?.image) ||
    (ours.containerRunning && !foreignDockerProxy) ||
    (!docker && ours.luaOnHost && (await listenerIsOurOpenResty(executor, listener)));

  return {
    port,
    pid: listener?.pid ?? undefined,
    command: docker
      ? `docker container ${docker.name} (${docker.image})`
      : listener?.command,
    rawCommand: listener?.rawCommand,
    systemdUnit: listener?.systemdUnit,
    systemdDescription: listener?.systemdDescription,
    isDocker: Boolean(docker),
    containerName: docker?.name,
    proxy,
    managedByOpenship,
  };
}

/** Detect and classify what owns ports 80/443. Read-only. */
export async function probeEdge(executor: CommandExecutor): Promise<EdgeStatus> {
  // Two independent "ours" signals: a running edge CONTAINER is authoritative on
  // its own (self-takeover lock); Lua-on-host only counts alongside a listener
  // that resolves to our OpenResty (bare-host regression guard). Kept separate
  // so probeEdgePort can apply each rule correctly.
  const containerRunning = await ourEdgeContainerRunning(executor);
  const luaOnHost = await ourLuaOnHost(executor);

  const all: EdgeOccupant[] = [];
  for (const port of EDGE_PORTS) {
    const occ = await probeEdgePort(executor, port, { containerRunning, luaOnHost });
    if (occ) all.push(occ);
  }

  const foreign = all.filter((o) => !o.managedByOpenship);

  let classification: EdgeStatus["classification"];
  if (all.length === 0) classification = "free";
  else if (foreign.length === 0) classification = "ours";
  else if (foreign.every((o) => o.proxy && o.proxy !== "openresty")) classification = "known";
  else classification = "unknown";

  return {
    classification,
    occupants: foreign,
    canProceedClean: classification === "free" || classification === "ours",
  };
}

/**
 * Map foreign occupants to the concrete stop targets a takeover would act on.
 *
 * Occupants are per-port, so ONE proxy on :80 + :443 appears twice — deduped by
 * identity (unit / container / pid) so we stop it once instead of issuing the same
 * `systemctl disable --now` (or the same `kill`, which on the second pass targets
 * a PID we already reaped) twice.
 */
export function stopTargetsForStatus(status: EdgeStatus): EdgeStopTarget[] {
  const out: EdgeStopTarget[] = [];
  const seen = new Set<string>();
  for (const o of status.occupants) {
    const identity = o.systemdUnit ?? o.containerName ?? (o.pid ? `pid:${o.pid}` : `port:${o.port}`);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push({
      port: o.port,
      unit: o.systemdUnit,
      pid: o.pid,
      container: o.containerName,
      // Prefer the proxy kind over the raw cmdline — `nginx (PID 123)` reads
      // better in "Stopping …" than `nginx: master process /usr/sbin/nginx …`.
      label: o.proxy && o.pid ? `${o.proxy} (PID ${o.pid})` : o.command,
    });
  }
  return out;
}

/**
 * Stop AND disable the identified owners of the edge ports so they don't
 * resurrect on reboot and re-grab 80/443 before OpenResty — services get
 * `disable`d, containers get their restart policy cleared. Never a blind
 * `fuser -k`; a bare process falls back to graceful-then-hard kill.
 */
export async function freeEdgeTargets(
  executor: CommandExecutor,
  targets: EdgeStopTarget[],
  onLog: (message: string, level?: "info" | "warn" | "error") => void,
): Promise<void> {
  for (const t of targets) {
    const where = t.port ? ` (port ${t.port})` : "";
    if (t.container) {
      onLog(`Stopping container ${t.container}${where}...`, "warn");
      // Clear the restart policy first so `docker stop` is durable across a daemon/host reboot.
      await tryExec(executor, `docker update --restart=no ${sq(t.container)} 2>/dev/null || true`);
      await tryExec(executor, `docker stop ${sq(t.container)} 2>/dev/null || true`);
    } else if (t.unit) {
      onLog(`Stopping & disabling service ${t.unit}${where}...`, "warn");
      await tryExec(
        executor,
        `systemctl disable --now ${sq(t.unit)} 2>/dev/null || systemctl stop ${sq(t.unit)} 2>/dev/null || true; ` +
          `systemctl reset-failed ${sq(t.unit)} 2>/dev/null || true`,
      );
    } else if (t.pid) {
      onLog(`Stopping ${t.label ?? `process ${t.pid}`}${where}...`, "warn");
      await tryExec(executor, `kill ${t.pid} 2>/dev/null || true`);
      await new Promise((r) => setTimeout(r, 800));
      await tryExec(executor, `kill -9 ${t.pid} 2>/dev/null || true`);
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
}
