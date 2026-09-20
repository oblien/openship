import { DeployError, shellQuote } from "@repo/core";
import type { CommandExecutor } from "../types";
import type { BuildLogger } from "./build-pipeline";
import type { PromptUserFn } from "./deploy-pipeline";
import { probePortListeningOnce, waitForPortFree } from "../system/port-listen";
import { tryExec } from "../system/probe-exec";
import {
  containerIdFromCgroup,
  describeContainerById,
  isBuildHelperContainer,
  isContainerPortForwarder,
  isOpenshipContainer,
  isOpenshipPlatformContainer,
  isOurEdgeContainer,
  managedDeploymentIdFromUnit,
  mayStopUnitForAppPort,
  resolveContainerPublishingPort,
  stopContainerDurably,
  type PortContainer,
} from "../system/port-owner";

/**
 * What `freePortOccupant` is permitted to act on for a given occupant.
 *
 * `none` is a real answer, not a failure to decide: the port is occupied by something
 * we cannot free without taking more down than the deploy is worth, so the operator
 * has to resolve it. Derived in exactly one place ({@link portStopTarget}) and carried
 * into the prompt and the error details, so the label the operator reads, the command
 * that runs, and the copy the API shows afterwards cannot disagree.
 */
export type PortStopTarget = "container" | "unit" | "process" | "none";

export interface PortOccupant {
  /** Owner PID, or `null` when the port is listening but its owner couldn't be
   *  resolved (procfs-only fallback / non-root ss) — occupancy is still known. */
  pid: number | null;
  command: string;
  rawCommand?: string;
  /** Whether `/proc/<pid>/cgroup` produced a non-empty snapshot. `false` is
   *  deliberately distinct from "no container id": callers that may signal a
   *  process must not treat an unreadable cgroup as proof it is host-owned. */
  cgroupVerified?: boolean;
  /** The verified snapshot used to bind a safety decision to this process. Kept
   *  internal to runtime code (it is intentionally omitted from error details). */
  processCgroup?: string;
  systemdUnit?: string;
  systemdDescription?: string;
  deploymentId?: string;
  isManagedDeployment?: boolean;
  /** The container holding the port, when one was resolved — by publish filter, or
   *  from the listener's own cgroup for a host-networked container. */
  containerId?: string;
  containerName?: string;
  containerImage?: string;
  /** `openship.project` / `openship.service` off that container's labels. */
  ownerProjectId?: string;
  serviceName?: string;
  /** The port is published by a container runtime, so the listener is a forwarder and
   *  any unit resolved from its cgroup is the DAEMON's, not the workload's. */
  dockerPublished?: boolean;
  /** The container is part of Openship ITSELF (the compose control plane, the mail
   *  engine, the edge) — never a stop target for an application port. */
  platformContainer?: boolean;
  /** More than one container publishes this port (same port, different host IPs), so
   *  ownership is genuinely undecidable — never guess which one to stop. */
  ambiguousOwners?: number;
}

async function resolveListenerOwner(
  executor: CommandExecutor,
  pid: number,
): Promise<
  Pick<
    PortOccupant,
    | "systemdUnit"
    | "systemdDescription"
    | "deploymentId"
    | "isManagedDeployment"
    | "containerId"
    | "cgroupVerified"
    | "processCgroup"
  >
> {
  // Do not append `|| true`: a permission/read failure must remain different from
  // a readable host cgroup with no container id. `/proc/<pid>/cgroup` is non-empty
  // for every live Linux process, including the root cgroup (`0::/`).
  const cgroup = (await tryExec(executor, `cat /proc/${pid}/cgroup 2>/dev/null`))?.trim();
  if (!cgroup) return { cgroupVerified: false };
  const evidence = { cgroupVerified: true as const, processCgroup: cgroup };

  // A process INSIDE a container: the cgroup names the container, and any `*.service`
  // leaf above it belongs to the daemon that started it. Return the container and
  // NOTHING else — attributing that unit to the workload is the whole of #628, and it
  // is also how a host-networked edge's OpenResty ended up a bare `kill -9` target.
  const containerId = containerIdFromCgroup(cgroup);
  if (containerId) return { ...evidence, containerId };

  // Reject anything that isn't a plain systemd unit name — the value is parsed from
  // /proc text and later interpolated into `systemctl` commands. Quoted at the call
  // site as well; this keeps a crafted cgroup leaf from being carried around at all.
  const systemdUnit = cgroup?.match(/(?:^|\/)([^/\n]+\.service)(?:$|\n|\/)/m)?.[1]?.trim();
  if (!systemdUnit || !/^[A-Za-z0-9@._:-]+\.service$/.test(systemdUnit)) {
    return evidence;
  }

  const description = await tryExec(
    executor,
    `systemctl show ${shellQuote(systemdUnit)} --property=Description --value 2>/dev/null || true`,
  );
  const deploymentId = managedDeploymentIdFromUnit(systemdUnit);

  return {
    ...evidence,
    systemdUnit,
    systemdDescription: description?.trim() || undefined,
    ...(deploymentId
      ? { deploymentId, isManagedDeployment: true }
      : { isManagedDeployment: false }),
  };
}

/** Why a port whose owner we CAN see is one we won't offer to free. */
export type PortRefusal =
  | "ambiguous"
  | "our-edge"
  | "platform"
  | "unidentified-container"
  | "docker-blind"
  | "protected-unit"
  | "no-owner";

export type PortVerdict =
  | { target: "container" | "unit" | "process" }
  | { target: "none"; why: PortRefusal };

/**
 * What may be stopped to free this port, and when nothing may be, WHY — the ONE rule,
 * read by the prompt label, the stop itself, and every operator-facing sentence.
 *
 * Precedence is container → unit → process, mirroring the edge takeover's: a container
 * is the most precise owner we can name, and preferring it is what keeps a published
 * port from ever resolving to the daemon that forwards it.
 *
 * The refusal REASON is returned from here rather than re-derived by the copy, because
 * a second chain over the same fields drifted immediately: it had no `platform` arm, so
 * refusing to stop Openship's own API container fell through to the docker-blind copy
 * and told the operator to go `docker stop` it by hand — #628 restated as prose. A
 * total switch on {@link PortRefusal} makes a new refusal a compile error instead.
 */
export function portStopVerdict(occupant: PortOccupant): PortVerdict {
  // Two owners for one port: stopping either is a coin flip with someone's app.
  if (occupant.ambiguousOwners) return { target: "none", why: "ambiguous" };

  if (occupant.containerId) {
    // The edge is checked BEFORE the general platform test so it keeps its own, more
    // specific copy — `isOpenshipPlatformContainer` is true for the edge as well. It
    // also works from name/image alone, so it still holds for an occupant built by the
    // cheap probe, which never asks who the platform containers are.
    if (isOurEdgeContainer(occupant.containerName, occupant.containerImage)) {
      return { target: "none", why: "our-edge" };
    }
    // Openship's own control plane or mail engine.
    if (occupant.platformContainer) return { target: "none", why: "platform" };
    // An id off a cgroup with no name or image behind it: docker could not describe it,
    // so the checks above could not run. Stopping a container we cannot identify is
    // exactly how the host-networked edge — invisible to `--filter publish` — would be
    // taken down for one app's port.
    if (!occupant.containerName && !occupant.containerImage) {
      return { target: "none", why: "unidentified-container" };
    }
    return { target: "container" };
  }

  // A container runtime published this port but we could not name the container — no
  // docker CLI, no socket permission, or a dropped transport. Both remaining arms are
  // wrong: the unit is the daemon, and the PID is dockerd's forwarder, whose death
  // severs a live container's port mapping. Ownership unproven → operator's call.
  if (occupant.dockerPublished) return { target: "none", why: "docker-blind" };

  if (mayStopUnitForAppPort(occupant.systemdUnit)) return { target: "unit" };
  // A unit resolved but is one we refuse to stop; killing its main PID would be the
  // same act with less bookkeeping, so this is not a fallback to `process`.
  if (occupant.systemdUnit) return { target: "none", why: "protected-unit" };

  return occupant.pid ? { target: "process" } : { target: "none", why: "no-owner" };
}

/** The verdict's target alone — what the details bag and the prompt label read. */
export function portStopTarget(occupant: PortOccupant): PortStopTarget {
  return portStopVerdict(occupant).target;
}

async function freePortOccupant(
  executor: CommandExecutor,
  port: number,
  occupant: PortOccupant,
  logger: BuildLogger,
): Promise<void> {
  switch (portStopTarget(occupant)) {
    case "container": {
      const label = occupant.containerName ?? occupant.containerId!;
      logger.log(`Stopping container ${label} to free port ${port}...\n`);
      // Unlike the edge takeover this path keeps no rollback journal, so the restart
      // policy `stopContainerDurably` clears is announced instead: it is the one durable
      // edit to a container the operator only agreed to STOP, and one command undoes it.
      logger.log(
        `Clearing ${label}'s restart policy so it can't reclaim port ${port} on reboot ` +
          `(restore with: docker update --restart=always ${label}).\n`,
        "warn",
      );
      await stopContainerDurably(executor, occupant.containerId!);
      break;
    }
    case "unit":
      logger.log(`Stopping systemd unit ${occupant.systemdUnit} to free port ${port}...\n`);
      await executor.exec(
        `systemctl stop ${shellQuote(occupant.systemdUnit!)} 2>/dev/null || true; ` +
          `systemctl reset-failed ${shellQuote(occupant.systemdUnit!)} 2>/dev/null || true`,
      );
      break;
    case "process":
      logger.log(`Killing ${occupant.command} to free port ${port}...\n`);
      await executor.exec(`kill -9 ${occupant.pid} 2>/dev/null || true`);
      break;
    case "none":
      // Unreachable: `ensurePortAvailable` never offers the free action for a `none`
      // target. Kept explicit so a future caller that skips the prompt can't fall
      // through into one of the arms above.
      logger.log(`Can't free port ${port} automatically: ${occupant.command}.\n`, "warn");
      return;
  }

  // "I stopped its owner" and ":<port> is bindable" are different facts, and only the
  // second lets the deploy bind — a unit takes a moment to release the socket. The
  // fixed 1s sleep this replaces was routinely too short, which surfaced as the
  // still-in-use throw below on a stop that had in fact worked.
  const { checked } = await waitForPortFree(executor, port, { timeoutMs: 10_000 });
  // `checked:false` = the socket table was never readable, so nothing was observed
  // either way. Say so: the re-probe that follows reads an unreadable host as "free",
  // and a deploy that then fails to bind should not be the first hint of that.
  if (!checked) {
    logger.log(
      `Couldn't confirm port ${port} was released (socket table unreadable) — continuing.\n`,
      "warn",
    );
  }
}

/**
 * Find who (if anyone) is LISTENing on `port`, via a tiered fallback so the
 * probe behaves consistently regardless of which tools a host ships:
 *   1. `ss -l` / `lsof`    — ordinary unprivileged ownership probe.
 *   2. `sudo -n ss`/`lsof` — targeted read-only retry only when tier 1 saw a
 *                            listener but Linux hid its PID.
 *   3. `/proc/net/tcp{,6}` — tool-free kernel socket table; presence only.
 *
 * Every tier is LISTEN-state filtered, so an outbound/ESTABLISHED socket on the
 * port (e.g. a daemon dialing a remote :443) is never mistaken for an occupant —
 * that filtering is the whole point of keeping this in ONE place. Tier 3 (reused
 * from `port-listen`) runs only when no PID surfaced. Positive tier-1 evidence is
 * retained even if every later probe is unreadable, so losing ownership detail can
 * never turn an occupied port into a free one.
 */
async function resolveListener(
  executor: CommandExecutor,
  port: number,
): Promise<{ pid: number | null; occupied: boolean; checked: boolean }> {
  const out = await tryExec(
    executor,
    `ss -tlnp sport = :${port} 2>/dev/null | grep LISTEN || lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null || true`,
  );
  const listenerPid = (output: string | null): number | null => {
    if (!output) return null;
    const ssMatch = output.match(/pid=(\d+)/);
    // lsof -ti prints one bare PID per line; take the first. An ss LISTEN line
    // is never a bare number, so this can't mis-parse the ss branch.
    const lsofMatch = !ssMatch ? output.match(/^\s*(\d+)\s*$/m) : null;
    const parsed = ssMatch?.[1] ?? lsofMatch?.[1];
    if (!parsed) return null;
    const pid = Number.parseInt(parsed, 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  };

  const pid = listenerPid(out);
  if (pid) return { pid, occupied: true, checked: true };

  const observedListener = Boolean(out?.trim());
  if (observedListener) {
    // A non-root `ss` still prints the LISTEN socket but commonly hides
    // `users:((...,pid=...))`. Ask for just this socket table entry through
    // passwordless sudo; `-n` guarantees this read-only probe can never block on
    // a password prompt. Hosts without that permission simply fall through to
    // the presence-only result below.
    const privilegedOut = await tryExec(
      executor,
      `sudo -n ss -tlnp sport = :${port} 2>/dev/null | grep LISTEN || sudo -n lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null || true`,
      { timeout: 5_000 },
    );
    const privilegedPid = listenerPid(privilegedOut);
    if (privilegedPid) return { pid: privilegedPid, occupied: true, checked: true };
  }

  // Tier 3: presence check with no tool dependency. A listener already observed
  // by ss remains occupied even if procfs is unreadable or races to an empty
  // result; losing its PID must never turn positive evidence into "port free".
  const listening = await probePortListeningOnce(executor, port);
  return {
    pid: null,
    occupied: observedListener || listening === true,
    checked: observedListener || listening !== null,
  };
}

export interface ListeningPortProbe {
  /** Null only when no listener was found or the probe was inconclusive. */
  occupant: PortOccupant | null;
  /** False means every authoritative ownership/presence probe failed. */
  checked: boolean;
}

export interface ListeningPortOwnersProbe {
  occupants: PortOccupant[];
  /** False when every socket-table probe failed. */
  checked: boolean;
  /** False when a listener was visible but every distinct PID was not proven. */
  ownershipComplete: boolean;
}

function parseListenerPids(output: string | null): {
  observed: boolean;
  complete: boolean;
  pids: number[];
} {
  const lines = (output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { observed: false, complete: true, pids: [] };

  const pids = new Set<number>();
  let complete = true;
  for (const line of lines) {
    const matches = [...line.matchAll(/pid=(\d+)/g)].map((match) => match[1]);
    const bare = matches.length === 0 ? line.match(/^(\d+)$/)?.[1] : undefined;
    const values = bare ? [bare] : matches;
    if (values.length === 0) complete = false;
    for (const value of values) {
      const pid = Number.parseInt(value!, 10);
      if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
      else complete = false;
    }
  }
  return { observed: true, complete, pids: [...pids] };
}

/**
 * Enumerate every visible owner of one listening port.
 *
 * The ordinary UI probe intentionally returns one representative occupant.
 * Reload safety is stricter: SO_REUSEPORT/address-specific binds can put a
 * managed and a foreign master on the same port, so signalling based on the
 * first PID would miss the foreign owner.
 */
export async function probeListeningPortOwners(
  executor: CommandExecutor,
  port: number,
): Promise<ListeningPortOwnersProbe> {
  const command =
    `ss -tlnp sport = :${port} 2>/dev/null | grep LISTEN || ` +
    `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null || true`;
  const ordinary = parseListenerPids(await tryExec(executor, command));
  let evidence = ordinary;

  if (ordinary.observed && !ordinary.complete) {
    const privileged = parseListenerPids(
      await tryExec(
        executor,
        `sudo -n ss -tlnp sport = :${port} 2>/dev/null | grep LISTEN || ` +
          `sudo -n lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null`,
        { timeout: 5_000 },
      ),
    );
    if (privileged.observed && privileged.complete) evidence = privileged;
    else {
      evidence = {
        observed: true,
        complete: false,
        pids: [...new Set([...ordinary.pids, ...privileged.pids])],
      };
    }
  }

  if (!evidence.observed) {
    const listening = await probePortListeningOnce(executor, port);
    if (listening === null) return { occupants: [], checked: false, ownershipComplete: false };
    if (!listening) return { occupants: [], checked: true, ownershipComplete: true };
    return { occupants: [], checked: true, ownershipComplete: false };
  }

  const described = await Promise.all(
    evidence.pids.map((pid) => describeProcess(executor, pid).catch(() => null)),
  );
  const occupants = described.filter((row): row is PortOccupant => row !== null);
  return {
    occupants,
    checked: true,
    ownershipComplete: evidence.complete && occupants.length === evidence.pids.length,
  };
}

/**
 * Strict counterpart to {@link probeListeningPort}. It preserves whether a null
 * result was a real "not listening" reading or merely an unreadable socket table,
 * for callers that must not treat probe failure as proof a daemon is stopped.
 */
export async function probeListeningPortState(
  executor: CommandExecutor,
  port: number,
): Promise<ListeningPortProbe> {
  try {
    const { pid, occupied, checked } = await resolveListener(executor, port);
    if (!checked || !occupied) return { occupant: null, checked };
    if (pid === null) {
      return { occupant: { pid: null, command: "unknown listener" }, checked: true };
    }
    return { occupant: await describeProcess(executor, pid), checked: true };
  } catch {
    return { occupant: null, checked: false };
  }
}

/**
 * Probe what process (if any) is listening on a port — see `resolveListener` for
 * the ss → lsof → procfs fallback. Returns `null` when the port is free. When
 * something is listening but its owner can't be resolved, returns an occupant
 * with `pid: null` + an "unknown listener" label, so the port is never treated
 * as free even though there's no PID to act on.
 *
 * Cheap by construction — socket table and procfs only, never a `docker ps`. The
 * read-only callers (cert-failure text, supervisor EADDRINUSE detail) sit on paths
 * that run often; anything that intends to STOP the occupant wants
 * {@link resolvePortOwner} instead, which pays for the ownership query.
 */
export async function probeListeningPort(
  executor: CommandExecutor,
  port: number,
): Promise<PortOccupant | null> {
  return (await probeListeningPortState(executor, port)).occupant;
}

/**
 * Identify one PID the same way `probeListeningPort` identifies a port's owner —
 * args/comm label plus its systemd unit. Split out so a caller that resolved a
 * different PID than the raw listener (e.g. the edge probe walking an nginx
 * worker up to its master) describes it through the SAME path, rather than
 * hand-rolling a second `ps` + cgroup read.
 */
export async function describeProcess(
  executor: CommandExecutor,
  pid: number,
): Promise<PortOccupant> {
  let command = `PID ${pid}`;
  let rawCommand: string | undefined;
  const args = await tryExec(executor, `ps -p ${pid} -o args= 2>/dev/null || true`);
  if (args?.trim()) {
    rawCommand = args.trim();
    command = `${rawCommand} (PID ${pid})`;
  } else {
    const cmd = await tryExec(executor, `ps -p ${pid} -o comm= 2>/dev/null || true`);
    if (cmd?.trim()) {
      rawCommand = cmd.trim();
      command = `${rawCommand} (PID ${pid})`;
    }
  }

  // A container runtime's port forwarder. Its cgroup is the daemon's, so reading a
  // unit off it says `docker.service` (or `user@<uid>.service` rootless) and asserting
  // `isManagedDeployment: false` claims the port isn't ours when it may well be. Both
  // are left unset: the owner is a container, and only a port-keyed query can name it.
  if (isContainerPortForwarder(rawCommand)) {
    return { pid, command, rawCommand, dockerPublished: true };
  }

  const systemd = await resolveListenerOwner(executor, pid);
  return { pid, command, rawCommand, ...systemd };
}

/** Fold a resolved container's identity + labels onto an occupant. */
async function withContainer(
  executor: CommandExecutor,
  occupant: PortOccupant,
  container: PortContainer,
): Promise<PortOccupant> {
  const platform = await isOpenshipPlatformContainer(executor, container);
  return {
    ...occupant,
    dockerPublished: true,
    ...(platform ? { platformContainer: true } : {}),
    containerId: container.id,
    containerName: container.name,
    containerImage: container.image,
    ...(container.projectId ? { ownerProjectId: container.projectId } : {}),
    ...(container.deploymentId ? { deploymentId: container.deploymentId } : {}),
    ...(container.serviceName ? { serviceName: container.serviceName } : {}),
    // Ownership now rests on the container's labels, not on a unit name. Left
    // UNDEFINED when the container carries no `openship.project`: a container adopted
    // in place by the docker migration is tracked by Openship while wearing no labels
    // at all, so "no label" means "could not tell", never "not ours".
    ...(isOpenshipContainer(container) ? { isManagedDeployment: true } : {}),
    // Naming a build helper as such matters: it is ours and safe to stop, but an
    // operator told only "container X holds the port" has no way to know that.
    command:
      `docker container ${container.name} (${container.image})` +
      (isBuildHelperContainer(container) ? " — a leftover build helper" : ""),
  };
}

/**
 * Who owns `port`, for a caller that may act on the answer.
 *
 * {@link probeListeningPort} plus the one question a socket table cannot answer: on a
 * docker host the owner of a published port is a CONTAINER. Asked of docker, keyed on
 * the port, because
 *   - the listener is a forwarder whose cgroup names only the daemon, and
 *   - under `--userland-proxy=false` (and containerd's CNI portmap) there is no host
 *     listener at all — the publish is iptables DNAT, so the socket table reads FREE
 *     right up until docker refuses the bind with "port is already allocated".
 *
 * Returns `null` only when nothing is listening AND no container claims the port.
 */
export async function resolvePortOwner(
  executor: CommandExecutor,
  port: number,
): Promise<PortOccupant | null> {
  const listener = await probeListeningPort(executor, port);
  const onPort = await resolveContainerPublishingPort(executor, port);

  if (onPort.kind === "ambiguous") {
    const names = onPort.containers.map((c) => c.name).join(", ");
    return {
      ...(listener ?? { pid: null, command: "unknown listener" }),
      dockerPublished: true,
      ambiguousOwners: onPort.containers.length,
      command: `${onPort.containers.length} containers publishing port ${port} (${names})`,
    };
  }

  if (onPort.kind === "one") {
    // Only fold the container onto the listener when the listener is NOT the port's
    // real owner — a forwarder, or a process inside a container. `--filter publish` is
    // address-blind, so a genuine host process on `10.0.0.5:<port>` can coincide with a
    // container published on `127.0.0.1:<port>`; overwriting apache2 with that
    // container would name the wrong owner AND offer to stop it.
    const listenerIsProxyForOwner =
      !listener ||
      listener.dockerPublished ||
      Boolean(listener.containerId) ||
      listener.pid === null;
    if (listenerIsProxyForOwner) {
      return await withContainer(
        executor,
        listener ?? { pid: null, command: "unknown listener" },
        onPort.container,
      );
    }
    return listener;
  }

  // No publish match. A HOST-NETWORKED container publishes nothing, so its container
  // id only ever comes from the listener's own cgroup — resolve its labels through the
  // same path rather than leaving it a bare PID to `kill -9`.
  if (listener?.containerId) {
    const container = await describeContainerById(executor, listener.containerId);
    if (container) return await withContainer(executor, listener, container);
    // Could not name it, but we know it IS a container: neither its daemon's unit nor
    // its in-container PID is ours to touch. The id is KEPT — `portStopTarget` refuses a
    // container it cannot name, so the id authorizes nothing, and it is the one thing
    // that lets the operator run `docker inspect` on whatever this is.
    return { ...listener, dockerPublished: true };
  }

  return listener;
}

/**
 * The `DeployError.details` bag for a PORT_IN_USE, in ONE place.
 *
 * Persisted verbatim to `deployment.errorDetails` and read by the operator-facing
 * pending-action copy, so the three raisers (this module's prompt/abort throws and the
 * two supervisors' EADDRINUSE) must not each hand-list their own subset — that is how
 * a cancelled prompt and an EADDRINUSE came to describe the same occupant differently.
 */
export function portOccupantDetails(
  port: number,
  occupant: PortOccupant | null,
  /**
   * What the deploy would offer to stop — ONLY passed by the caller that actually
   * established ownership. Omitted by the supervisors, whose occupant comes from the
   * cheap probe and never asked docker: deriving it there stamps `"none"` on any
   * docker-published port, and the operator-facing copy would then promise no free
   * action for exactly the case where a redeploy offers a container stop.
   */
  stopTarget?: PortStopTarget,
): Record<string, unknown> {
  if (!occupant) return { port };
  return {
    port,
    pid: occupant.pid,
    command: occupant.command,
    rawCommand: occupant.rawCommand,
    systemdUnit: occupant.systemdUnit,
    systemdDescription: occupant.systemdDescription,
    deploymentId: occupant.deploymentId,
    isManagedDeployment: occupant.isManagedDeployment,
    containerId: occupant.containerId,
    containerName: occupant.containerName,
    containerImage: occupant.containerImage,
    ownerProjectId: occupant.ownerProjectId,
    serviceName: occupant.serviceName,
    dockerPublished: occupant.dockerPublished,
    platformContainer: occupant.platformContainer,
    ambiguousOwners: occupant.ambiguousOwners,
    ...(stopTarget ? { stopTarget } : {}),
  };
}

/** What the operator is agreeing to, in the words of the thing that will be stopped. */
function freeActionLabel(occupant: PortOccupant): string {
  switch (portStopTarget(occupant)) {
    case "container":
      return occupant.isManagedDeployment
        ? "Stop Openship Container & Continue"
        : "Stop Container & Continue";
    case "unit":
      return occupant.isManagedDeployment
        ? "Stop Openship Deployment & Continue"
        : "Stop Service & Continue";
    default:
      return "Free Port & Continue";
  }
}

/**
 * The refusal, in the operator's terms. One arm per {@link PortRefusal} and no
 * conditions of its own, so it cannot disagree with the rule about which case this is.
 */
function refusalReason(port: number, occupant: PortOccupant, why: PortRefusal): string {
  const named = occupant.containerName ?? occupant.containerId;
  switch (why) {
    case "ambiguous":
      return (
        `Port ${port} is published by ${occupant.ambiguousOwners} containers at once (${occupant.command}), ` +
        `so Openship can't tell which one owns it. Stop the right container yourself, or deploy on a different port.`
      );
    case "our-edge":
      return (
        `Port ${port} belongs to the Openship edge proxy (container ${named}), which routes every domain on this ` +
        `server. Deploy on a different host port and route it through the edge instead.`
      );
    case "platform":
      return (
        `Port ${port} is held by Openship itself — container ${named} is part of the control plane running this ` +
        `deploy. Stopping it would take Openship down, so deploy on a different host port.`
      );
    case "unidentified-container":
      return (
        `Port ${port} is held by container ${occupant.containerId}, which this Docker daemon won't describe — so ` +
        `Openship can't tell whether it is one of its own (the edge publishes nothing and is only visible this ` +
        `way). Run \`docker inspect ${occupant.containerId}\` on the server, stop it if it is safe to, then redeploy.`
      );
    case "docker-blind":
      return (
        `Port ${port} is published by a Docker container Openship couldn't identify — the process holding it is ` +
        `Docker's port forwarder, not the app, so there is nothing here Openship can safely stop. ` +
        `Run \`docker ps --filter publish=${port}\` on the server, stop that container, then redeploy.`
      );
    case "protected-unit":
      return (
        `Port ${port} is held by ${occupant.systemdUnit}, a service Openship will not stop — doing so would take ` +
        `down more than this deploy. Free the port on the server, or deploy on a different port.`
      );
    case "no-owner":
      return `Port ${port} is occupied by ${occupant.command}, which Openship can't free automatically.`;
  }
}

/**
 * Ensure a port is free before deploy. If occupied, pause for user input.
 *
 * The only MUTATING consumer of the port probe, and therefore the one that pays for
 * {@link resolvePortOwner}: what gets offered here turns straight into a command on
 * the operator's server. When the owner can be named but not safely stopped, no free
 * action is offered at all — an honest dead end beats a button that does more damage
 * than the conflict it clears.
 */
export async function ensurePortAvailable(
  executor: CommandExecutor,
  port: number,
  logger: BuildLogger,
  promptUser: PromptUserFn,
): Promise<void> {
  const occupant = await resolvePortOwner(executor, port);
  if (!occupant) return;

  const verdict = portStopVerdict(occupant);
  const stopTarget = verdict.target;

  if (verdict.target === "none") {
    const reason = refusalReason(port, occupant, verdict.why);
    logger.log(`${reason} Waiting for user decision...\n`, "warn");

    // Offer no stop — but still HOLD. The prompt is the operator's window to free the
    // port by hand and carry on: at HEAD that window existed only as a mislabelled
    // "Free Port & Continue" which freed nothing and then re-probed, and removing it
    // outright would throw away a built artifact for a conflict they could clear in a
    // shell in ten seconds. `re_check` says what it does instead of implying we will.
    const action = await promptUser({
      promptId: `port_in_use:${port}`,
      title: "Port In Use",
      message: reason,
      actions: [
        { id: "re_check", label: "I Freed It — Re-check", variant: "primary" },
        { id: "abort", label: "Cancel Deploy", variant: "secondary" },
      ],
      details: portOccupantDetails(port, occupant, stopTarget),
    });

    if (action === "re_check") {
      const remaining = await resolvePortOwner(executor, port);
      if (!remaining) return;
      logger.log(`Port ${port} is still held by ${remaining.command}.\n`, "error");
      const still = portStopVerdict(remaining);
      throw new DeployError(
        still.target === "none"
          ? `Port ${port} is still in use. ${refusalReason(port, remaining, still.why)}`
          : `Port ${port} is still in use by ${remaining.command}. Stop it and redeploy.`,
        "PORT_IN_USE",
        portOccupantDetails(port, remaining, still.target),
      );
    }

    throw new DeployError(reason, "PORT_IN_USE", portOccupantDetails(port, occupant, stopTarget));
  }

  logger.log(
    `Port ${port} is occupied by ${occupant.command}. Waiting for user decision...\n`,
    "warn",
  );

  const action = await promptUser({
    promptId: `port_in_use:${port}`,
    title: "Port In Use",
    message: occupant.isManagedDeployment
      ? `Port ${port} is occupied by ${occupant.command}, which Openship deployed.`
      : `Port ${port} is occupied by ${occupant.command}. This may not be a previous deployment.`,
    actions: [
      { id: "free_port", label: freeActionLabel(occupant), variant: "danger" },
      { id: "abort", label: "Cancel Deploy", variant: "secondary" },
    ],
    details: portOccupantDetails(port, occupant, stopTarget),
  });

  if (action === "free_port") {
    logger.log(`User chose to free port ${port} from ${occupant.command}...\n`);
    await freePortOccupant(executor, port, occupant, logger);

    const remaining = await resolvePortOwner(executor, port);
    if (!remaining) {
      return;
    }

    throw new DeployError(
      `Port ${port} is still in use by ${remaining.command}. Stop the existing process before deploying.`,
      "PORT_IN_USE",
      portOccupantDetails(port, remaining, portStopTarget(remaining)),
    );
  }

  throw new DeployError(
    `Deploy aborted: port ${port} is in use by ${occupant.command}`,
    "PORT_IN_USE",
    portOccupantDetails(port, occupant, stopTarget),
  );
}
