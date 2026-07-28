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
  const byName = await tryExec(
    executor,
    `docker ps --filter name=openship-edge --format '{{.Names}}' 2>/dev/null | head -1`,
  );
  if (byName && byName.trim()) return true;

  // Renamed container (OPENSHIP_EDGE_CONTAINER): still ours if it runs our image.
  const all = await tryExec(executor, `docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null`);
  if (!all) return false;
  return all
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      const [name, image] = line.split("\t");
      return isOurEdgeContainer(name, image);
    });
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
