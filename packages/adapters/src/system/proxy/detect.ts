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
import { waitForPortFree } from "../port-listen";
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
 *
 * This is also the ONLY honest "is the edge up" question on the box: a crash-looping
 * container reports `.State.Running == true` and appears in plain `docker ps`, so
 * every running-only probe (`resolveOurEdgeContainer`, `docker ps --filter name=`)
 * says yes while nothing is being served. Pass `container` to ask about a specific
 * one — a container renamed via OPENSHIP_EDGE_CONTAINER isn't `openship-edge`, and
 * inspecting the default name instead silently answers about a container that
 * doesn't exist (unreadable → "fine").
 */
export async function edgeIsBroken(
  executor: CommandExecutor,
  container = EDGE_CONTAINER_NAME,
): Promise<boolean> {
  const status = await tryExec(
    executor,
    `docker inspect -f '{{.State.Status}}' ${sq(container)} 2>/dev/null`,
  );
  const state = (status ?? "").trim();
  return state === "restarting" || state === "exited" || state === "dead";
}

/**
 * Why the edge container isn't running, from its own log on the box `executor`
 * reaches. Parsing is {@link edgeFailureReason}, so every caller agrees on the cause.
 */
export async function edgeCrashReason(
  executor: CommandExecutor,
  container = EDGE_CONTAINER_NAME,
): Promise<string | null> {
  const logs = await tryExec(executor, `docker logs --tail 40 ${sq(container)} 2>&1`);
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

/**
 * The edge container's identity + run state INCLUDING when it's stopped — the
 * "track if installed" probe, deliberately distinct from
 * {@link resolveOurEdgeContainer} (RUNNING-only, on the takeover hot path where a
 * stopped edge must read as "no edge"). A `docker ps -a` pass so a
 * provisioned-but-stopped edge still resolves (`running:false`, `exists:true`)
 * instead of vanishing from tracking. Matches by NAME first, then by our image for
 * a container renamed via OPENSHIP_EDGE_CONTAINER. The `.Image` field carries the
 * created-with ref, which is what drift compares against the pinned ref — no extra
 * `docker inspect`.
 *
 * Three outcomes, not two — the distinction the drift cache depends on:
 *   - a match → `{ exists: true, … }`;
 *   - the query RAN and no line matched (incl. empty output) → `exists:false`, a
 *     CONFIDENT absence the caller may act on (drop the tracked row);
 *   - the `docker ps -a` itself failed (daemon momentarily unreachable, an SSH
 *     hiccup) → `null`, i.e. "couldn't tell". Collapsing this into `exists:false`
 *     is what let a transient probe error DELETE a live edge's cached row; `null`
 *     tells the caller to keep the last-known state instead.
 */
export async function detectEdgeContainer(
  executor: CommandExecutor,
): Promise<{ name: string | null; running: boolean; image: string | null; exists: boolean } | null> {
  const out = await tryExec(
    executor,
    `docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.State}}' 2>/dev/null`,
  );
  // `null` = the command threw (inconclusive). An empty string = it ran and there
  // are no containers — a real absence, not a failure.
  if (out === null) return null;
  const absent = { name: null, running: false, image: null, exists: false };
  for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [name, image, state] = line.split("\t");
    if (!name) continue;
    if (name === EDGE_CONTAINER_NAME || isOurEdgeContainer(name, image)) {
      return { name, image: image || null, running: state === "running", exists: true };
    }
  }
  return absent;
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
  ours: { containerRunning: boolean },
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

  // "Ours" means EXACTLY ONE THING: our edge CONTAINER. Two shapes of the same
  // fact, because host networking hides the publish:
  //   - OUR edge container publishes this port (bridged `openship-edge`) — the
  //     docker occupant IS our edge image/name.
  //   - our edge container is RUNNING and healthy (host-networked → no docker
  //     publish match). A running edge container OWNS 80/443, so the host-process
  //     occupant here IS its OpenResty — marked ours WITHOUT depending on the
  //     listener's binary path (the host may render the master as
  //     `nginx: master process nginx …` with no `openresty` prefix, and
  //     `readlink /proc/<pid>/exe` can be denied). THIS is the self-takeover lock:
  //     our own edge must never read as foreign and get killed by the takeover.
  //
  // A BARE HOST OpenResty is NOT ours, even one an older Openship installed. The
  // edge is a container; a host OpenResty is a proxy to MIGRATE FROM, exactly like
  // a distro nginx or a Caddy (`canImportProxy("openresty")` is true and
  // `scanOpenshipEdge` reads both bare sites-enabled layouts). Calling it "ours"
  // was the whole bug: `classification` came back `ours`, `canProceedClean` was
  // true, the consent gate returned immediately, nothing stopped it, and the edge
  // container then crash-looped forever on
  // `bind() to 0.0.0.0:80 failed (98: Address already in use)` while every surface
  // reported the edge installed and running.
  const managedByOpenship =
    isOurEdgeContainer(docker?.name, docker?.image) ||
    (ours.containerRunning && !foreignDockerProxy);

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
  // ONE "ours" signal: a HEALTHY edge CONTAINER (the self-takeover lock).
  //
  // The health gate is load-bearing, not defensive: a crash-looping edge is still
  // "running" to docker, and the lock would then claim whatever ACTUALLY holds :80
  // — the very proxy that caused the crash loop — as ours, so the consent gate
  // returns clean and nothing is ever stopped. `edgeIsBroken` answers "no" when it
  // can't tell, so the lock still holds for a healthy edge on a box where inspect
  // is unreadable.
  const container = await resolveOurEdgeContainer(executor);
  const containerRunning = Boolean(container) && !(await edgeIsBroken(executor, container!));

  const occupants: EdgeOccupant[] = [];
  for (const port of EDGE_PORTS) {
    const occ = await probeEdgePort(executor, port, { containerRunning });
    if (occ) occupants.push(occ);
  }

  const foreign = occupants.filter((o) => !o.managedByOpenship);

  let classification: EdgeStatus["classification"];
  if (occupants.length === 0) classification = "free";
  else if (foreign.length === 0) classification = "ours";
  // `known` = we recognize it AND can import its config, which is what makes the
  // migrate offer real. `openresty` belongs here now: with a containerized edge a
  // host OpenResty is a migration SOURCE (see `canImportProxy`), and excluding it
  // sent the one proxy whose vhosts we parse most reliably — our own former bare
  // edge — down the `unknown`/takeover-only path, i.e. "drop every site it serves".
  else if (foreign.every((o) => o.proxy)) classification = "known";
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

/** Outcome of {@link freeEdgeTargets} — did the ports ACTUALLY come free. */
export interface EdgeFreeResult {
  /** True when no stopped port was observed still holding a LISTEN socket. */
  freed: boolean;
  /** Ports still bound afterwards (conclusive readings only — never a guess). */
  stillBound: number[];
}

/**
 * Stop AND disable the identified owners of the edge ports so they don't
 * resurrect on reboot and re-grab 80/443 before OpenResty — services get
 * `disable`d, containers get their restart policy cleared. Never a blind
 * `fuser -k`; a bare process falls back to graceful-then-hard kill.
 *
 * Then PROVE the ports are free, because "I stopped its owner" and ":80 is
 * bindable" are different facts and only the second one lets our edge start: a
 * unit takes a moment to release the socket and its master may respawn a worker
 * in between. Every takeover path — nginx, caddy, apache, and now a legacy bare
 * host OpenResty — funnels through here, so this is the single place that
 * guarantee lives, and the single place callers read it from instead of starting
 * a container that loses the race and crash-loops on
 * `bind() … (98: Address already in use)` while `docker run` exits 0.
 */
export async function freeEdgeTargets(
  executor: CommandExecutor,
  targets: EdgeStopTarget[],
  onLog: (message: string, level?: "info" | "warn" | "error") => void,
  // Per-port budget for the socket to drain. The caller owns this: an interactive
  // takeover can afford to wait, a per-deploy re-ensure can't sit for half a minute
  // on two ports it already expects to be free.
  opts: { timeoutMs?: number } = {},
): Promise<EdgeFreeResult> {
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

  // Verify the ports we were asked about; an EdgeStopTarget may carry none (a
  // pre-accepted policy names units, not ports), in which case both edge ports
  // are what we were freeing.
  const named = [...new Set(targets.map((t) => t.port).filter((p): p is number => typeof p === "number"))];
  const stillBound: number[] = [];
  for (const port of named.length ? named : [...EDGE_PORTS]) {
    const { free, checked } = await waitForPortFree(executor, port, {
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    // `checked:false` = we couldn't read the socket table at all. Not evidence of
    // anything, so it must not read as "still bound" and block a takeover that in
    // fact worked.
    if (!checked) {
      onLog(`Couldn't confirm port ${port} was released (socket table unreadable) — continuing.`, "warn");
      continue;
    }
    if (!free) {
      stillBound.push(port);
      onLog(`Port ${port} is STILL bound after stopping its owner.`, "error");
    }
  }
  return { freed: stillBound.length === 0, stillBound };
}
