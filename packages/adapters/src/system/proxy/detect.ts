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
import { probeListeningPort } from "../../runtime/port-conflict";
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

/** Our OpenResty owns the edge iff our Lua scripts are deployed. */
export async function isOpenshipManagedEdge(executor: CommandExecutor): Promise<boolean> {
  const out = await tryExec(
    executor,
    `test -f ${OPENRESTY_LUA_DIR}/site_logger.lua && echo ok`,
  );
  return Boolean(out && out.includes("ok"));
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

async function probeEdgePort(
  executor: CommandExecutor,
  port: number,
  ourEdge: boolean,
): Promise<EdgeOccupant | null> {
  const listener = await probeListeningPort(executor, port);
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

  // "Ours" means the process ACTUALLY LISTENING is our OpenResty — NOT merely a
  // process named "nginx" while our Lua happens to sit on disk from a past run.
  // OpenResty lives under an `openresty` prefix (e.g. /usr/local/openresty/nginx/
  // sbin/nginx); a distro proxy is /usr/sbin/nginx. Trusting the "nginx" name here
  // is what made a foreign nginx look managed → the takeover was silently skipped.
  // A containerized proxy is never our host OpenResty.
  const managedByOpenship =
    ourEdge && !docker && (await listenerIsOurOpenResty(executor, listener));

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
  const ourEdge = await isOpenshipManagedEdge(executor);

  const all: EdgeOccupant[] = [];
  for (const port of EDGE_PORTS) {
    const occ = await probeEdgePort(executor, port, ourEdge);
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

/** Map foreign occupants to the concrete stop targets a takeover would act on. */
export function stopTargetsForStatus(status: EdgeStatus): EdgeStopTarget[] {
  return status.occupants.map((o) => ({
    port: o.port,
    unit: o.systemdUnit,
    pid: o.pid,
    container: o.containerName,
    label: o.command,
  }));
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
