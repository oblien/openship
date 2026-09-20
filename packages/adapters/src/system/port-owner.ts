/**
 * Who owns a host port, and what Openship is ALLOWED to stop to take it.
 *
 * Lifted out of the deploy-time port probe, and shared with the edge takeover,
 * because both resolved a port's owner the same wrong way. The process LISTENING on
 * a published container port is `docker-proxy`, a child of dockerd, so walking its
 * `/proc/<pid>/cgroup` names `docker.service` — and "stop whatever holds the port"
 * then meant `systemctl stop docker.service`: the daemon and every hosted app on the
 * box, to publish one container (#628). Enumerating daemon names does not close it —
 * rootless lands on `user@<uid>.service` (the operator's entire session manager) and
 * snap on `snap.docker.dockerd.service` — so the fix is to recognize the FORWARDER
 * and stop believing its cgroup, with the name lists kept only as backstops.
 *
 * Three halves, deliberately in one module:
 *   - ask DOCKER who publishes the port, keyed on the PORT rather than inferred from
 *     the listener, because on a docker host the answer is a container and a cgroup
 *     cannot name which one (and under `--userland-proxy=false` there is no host
 *     listener at all — the publish is pure iptables DNAT);
 *   - which systemd units may be stopped, for each of the two callers, since they
 *     want different answers about proxies and only one of them is a takeover;
 *   - which containers are Openship's OWN, because the control plane runs as a
 *     compose stack and "stop the container on port 4000" is otherwise a way for a
 *     deploy to stop the API running it.
 */

import { shellQuote } from "@repo/core";

import { MAIL_CONTAINER, MAIL_DB_CONTAINER } from "../infra/mail-container";
import type { ExecOnly } from "../types";
import type { ProxyKind } from "./types";
import { tryExec } from "./probe-exec";

/** The labels `DockerRuntime.labels()` stamps on everything Openship creates. */
export const OPENSHIP_LABEL = {
  project: "openship.project",
  deployment: "openship.deployment",
  service: "openship.service",
  build: "openship.build",
} as const;

/** A container publishing a host port, with the labels that decide ownership. */
export interface PortContainer {
  /** Full 64-hex id (`--no-trunc`) — the value handed to `docker stop`. */
  id: string;
  name: string;
  image: string;
  projectId?: string;
  deploymentId?: string;
  serviceName?: string;
  buildSessionId?: string;
  composeProject?: string;
  composeService?: string;
}

/**
 * The answer to "which container publishes this port".
 *
 * `unknown` and `none` are the two the caller must never collapse: no docker CLI, no
 * socket permission or a dropped transport is `unknown` (ownership unproven → refuse
 * to stop anything), while an answering daemon with no match is `none` (a genuine
 * host process). Collapsing them re-creates #628 in reverse — one SSH hiccup and the
 * caller falls back to the listener's `docker.service` cgroup again.
 */
export type ContainerOnPort =
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "one"; container: PortContainer }
  | { kind: "ambiguous"; containers: PortContainer[] };

// Tab-separated so an EMPTY label keeps its column: `.Label` renders a missing key
// as an empty field rather than omitting it, so a foreign container's line has the
// same field count as ours and must be read by index, never by count.
const PS_FIELDS = [
  "{{.ID}}",
  "{{.Names}}",
  "{{.Image}}",
  `{{.Label "${OPENSHIP_LABEL.project}"}}`,
  `{{.Label "${OPENSHIP_LABEL.deployment}"}}`,
  `{{.Label "${OPENSHIP_LABEL.service}"}}`,
  `{{.Label "${OPENSHIP_LABEL.build}"}}`,
  '{{.Label "com.docker.compose.project"}}',
  '{{.Label "com.docker.compose.service"}}',
];
const PS_FORMAT = PS_FIELDS.join("\\t");

function parsePsLines(out: string): PortContainer[] {
  const containers: PortContainer[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    const id = f[0]?.trim();
    const name = f[1]?.trim();
    // Label VALUES are printed verbatim, so a label containing a newline splits one
    // container's line in two and the tail would parse as a second, invented one —
    // turning a single stoppable owner into a bogus "2 containers publish this port".
    // A real row always starts with a hex id, which no label tail can imitate.
    if (!id || !name || !/^[0-9a-f]{12,64}$/i.test(id)) continue;
    containers.push({
      id,
      name: name.replace(/^\//, ""),
      image: f[2]?.trim() ?? "",
      ...(f[3]?.trim() ? { projectId: f[3].trim() } : {}),
      ...(f[4]?.trim() ? { deploymentId: f[4].trim() } : {}),
      ...(f[5]?.trim() ? { serviceName: f[5].trim() } : {}),
      ...(f[6]?.trim() ? { buildSessionId: f[6].trim() } : {}),
      ...(f[7]?.trim() ? { composeProject: f[7].trim() } : {}),
      ...(f[8]?.trim() ? { composeService: f[8].trim() } : {}),
    });
  }
  return containers;
}

/**
 * Run one `docker ps` filter query. Deliberately WITHOUT a trailing `|| true`: the
 * exit code is the only thing separating "docker could not answer" from "docker
 * answered, nothing matched", and forcing exit 0 — the house habit everywhere else
 * in this layer — would erase exactly the distinction {@link ContainerOnPort}
 * exists to carry. stderr is dropped because the message adds nothing a caller acts
 * on. Bare `docker`, no sudo, matching every other invocation in this layer.
 *
 * `--no-trunc` so `.ID` is the full 64-hex id: the value reaches `docker stop`, and a
 * truncated id is a prefix match rather than an identity.
 */
async function queryContainers(executor: ExecOnly, filter: string): Promise<PortContainer[] | null> {
  const out = await tryExec(
    executor,
    `docker ps --no-trunc --filter ${filter} --format '${PS_FORMAT}' 2>/dev/null`,
  );
  return out === null ? null : parsePsLines(out);
}

/**
 * Which container publishes `port` on the host.
 *
 * `--filter publish=` matches on the published host port and IGNORES which host IP
 * it is bound to, so two containers publishing the same port on different addresses
 * both match. That is the ambiguity the issue requires us to fail safely on, and the
 * reason this does not carry the `| head -1` its edge-probe ancestor used — picking
 * "newest first" out of two owners is how the wrong app gets stopped. Running
 * containers only (`-a` does not extend the publish filter to stopped ones), and tcp
 * by default, which is every port a deploy binds.
 */
export async function resolveContainerPublishingPort(
  executor: ExecOnly,
  port: number,
): Promise<ContainerOnPort> {
  // A malformed port makes the daemon reject the filter outright, which would
  // otherwise read as "no container". Nothing to ask about either way.
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { kind: "unknown" };

  const containers = await queryContainers(executor, `publish=${port}`);
  if (containers === null) return { kind: "unknown" };
  if (containers.length === 0) return { kind: "none" };
  if (containers.length === 1) return { kind: "one", container: containers[0]! };
  return { kind: "ambiguous", containers };
}

/**
 * A container's own cgroup path carries its full id. Every runtime writes it
 * differently — `/system.slice/docker-<id>.scope` (v2 + systemd driver), `/docker/<id>`
 * (cgroupfs / v1), `/kubepods.slice/…/cri-containerd-<id>.scope`, `libpod-<id>`,
 * `nerdctl-<id>` — so this matches the 64-hex token itself rather than enumerating
 * prefixes: missing a shape means the listener falls through to being `kill -9`'d as
 * a plain host process, which for a process inside somebody's container is the same
 * class of mistake as #628.
 *
 * Bounded by a non-hex character on both sides so it cannot match part of a longer
 * digest, and this is the only way a HOST-NETWORKED container (our own edge) is
 * visible at all — it publishes nothing, so `--filter publish` never sees it.
 */
export function containerIdFromCgroup(cgroup: string | null | undefined): string | null {
  const match = cgroup?.match(/(?:^|[^0-9a-f])([0-9a-f]{64})(?:[^0-9a-f]|$)/);
  return match?.[1] ?? null;
}

/**
 * Stop a container so it stays stopped.
 *
 * `docker stop` alone suppresses the restart policy only for the current daemon session:
 * `restart: always` (unlike `unless-stopped`) starts the container again when the daemon
 * does, i.e. on every host reboot and every docker upgrade. Both callers — the deploy
 * freeing an application port and the edge takeover reclaiming 80/443 — need the stop to
 * outlive a reboot, and each had the pair written out separately, with a different shell
 * quoter. Best-effort: a stop that could not run surfaces as the port still being bound,
 * which is what both callers actually check.
 *
 * `ref` may be an id or a name; it is quoted either way.
 */
export async function stopContainerDurably(executor: ExecOnly, ref: string): Promise<void> {
  await tryExec(executor, `docker update --restart=no ${shellQuote(ref)} 2>/dev/null || true`);
  await tryExec(executor, `docker stop ${shellQuote(ref)} 2>/dev/null || true`);
}

/**
 * Identify a container by id (the cgroup hop's answer).
 *
 * `null` deliberately collapses "could not ask" and "no such container here" — the
 * distinction {@link ContainerOnPort} keeps apart elsewhere — because both mean the
 * same thing to the only caller: the id names a container this daemon will not
 * describe (a podman/nerdctl id, a rootless one seen from the rootful socket, one that
 * exited between the two queries), so it cannot be identified and cannot be stopped.
 */
export async function describeContainerById(
  executor: ExecOnly,
  containerId: string,
): Promise<PortContainer | null> {
  if (!/^[0-9a-f]{12,64}$/i.test(containerId)) return null;
  const containers = await queryContainers(executor, `id=${shellQuote(containerId)}`);
  return containers?.[0] ?? null;
}

/**
 * The edge we ship as a container: compose service `edge`, published image
 * `…/openship-edge`, default container name `openship-edge`. Recognized by name OR
 * image so a host-networked OR bridged edge counts as OUR edge. Matching the image
 * is the stable signal — the container name is configurable via
 * OPENSHIP_EDGE_CONTAINER.
 *
 * Lives here rather than next to the edge probe so the port-conflict path can refuse
 * to offer it as a stop target without importing upward into `proxy/detect` (which
 * imports the port probe, so that direction is a cycle). Re-exported there for its
 * existing callers.
 */
export const EDGE_CONTAINER_NAME = "openship-edge";

export function isOurEdgeContainer(name?: string, image?: string): boolean {
  return /openship-edge/i.test(`${name ?? ""} ${image ?? ""}`);
}

/** A container Openship created — `openship.project` is stamped on every one. */
export function isOpenshipContainer(container: PortContainer): boolean {
  return Boolean(container.projectId);
}

/**
 * A build helper, not a running app: it carries a build session and NEITHER a
 * deployment nor a service. The build label alone does not prove it — docker copies
 * image labels onto containers run from `openship/<app>:bld_…`, so a real deployment
 * inherits `openship.build` too.
 *
 * Keyed on the three markers rather than on a label bag or a container shape, because
 * the two callers hold different shapes — the migration scan has raw labels, the port
 * probe has a {@link PortContainer} — and this rule existed once per shape before,
 * which is one copy too many for a boolean that decides whether something is stoppable.
 */
export function isBuildHelperMarkers(markers: {
  build?: string;
  deployment?: string;
  service?: string;
}): boolean {
  return Boolean(markers.build) && !markers.deployment && !markers.service;
}

export function isBuildHelperContainer(container: PortContainer): boolean {
  return isBuildHelperMarkers({
    build: container.buildSessionId,
    deployment: container.deploymentId,
    service: container.serviceName,
  });
}

/** The images the control plane itself runs as. */
const PLATFORM_IMAGE_RE = /(?:^|\/)openship-(?:api|dashboard|edge)(?::|$)/i;
/** Containers Openship creates under a fixed name rather than through compose. */
const PLATFORM_NAMES = new Set<string>([EDGE_CONTAINER_NAME, MAIL_CONTAINER, MAIL_DB_CONTAINER]);

/**
 * Is this container part of Openship ITSELF, rather than something it deployed?
 *
 * `openship up` runs the control plane as a compose stack — api on 4000, dashboard on
 * 3001, plus postgres and redis — and the mail engine adds `openship-mail` on the SMTP
 * ports. None of them carry an `openship.project` label, so without this they read as
 * ordinary foreign containers and a deploy that wanted one of those ports would offer
 * "Stop Container & Continue" for the API serving the request.
 *
 * Name and image cover everything Openship publishes under its own identity. The
 * stack's postgres/redis run stock images under compose service names, so the only
 * thing marking THEM as ours is the compose project they share with the api — one
 * extra query, and only for a candidate that is part of some compose project.
 */
export async function isOpenshipPlatformContainer(
  executor: ExecOnly,
  container: PortContainer,
): Promise<boolean> {
  if (PLATFORM_NAMES.has(container.name)) return true;
  if (isOurEdgeContainer(container.name, container.image)) return true;
  if (PLATFORM_IMAGE_RE.test(container.image)) return true;
  // A container Openship deployed is a project's, never the platform's — and it is a
  // legitimate stop target, so don't let its compose project drag it in here.
  if (container.projectId || !container.composeProject) return false;

  const siblings = await queryContainers(
    executor,
    `label=com.docker.compose.project=${shellQuote(container.composeProject)}`,
  );
  return (siblings ?? []).some((s) => PLATFORM_IMAGE_RE.test(s.image));
}

const PORT_FORWARDER_NAMES = [
  "docker-proxy",
  "rootlesskit",
  "rootlesskit-docker-proxy",
  "slirp4netns",
  "pasta",
  // LXD/Incus publish a container port with `forkproxy`, whose cgroup is the snap's
  // daemon unit — the same misattribution with a different daemon.
  "forkproxy",
];

/**
 * Is this the host-side port forwarder of a container runtime? The port it holds
 * belongs to a CONTAINER — never to the unit its own cgroup names, which is dockerd's
 * `docker.service` rootful, or the operator's whole `user@<uid>.service` manager
 * rootless. Recognizing the forwarder is what makes #628 unreachable by construction
 * rather than by enumerating daemon names.
 *
 * Matched against argv0's BASENAME only, never anywhere in the command line: a
 * substring test reads `node /srv/docker-proxy/server.js` as dockerd's forwarder and
 * makes a real app's port unfreeable. Both shapes the probe produces are handled —
 * `ps -o args=` gives a path, `ps -o comm=` gives a bare name TRUNCATED TO 15 CHARS,
 * which is why a 15-char prefix of a longer forwarder name counts
 * (`rootlesskit-docker-proxy` arrives as `rootlesskit-doc`).
 */
export function isContainerPortForwarder(command: string | undefined): boolean {
  const argv0 = command?.trim().split(/\s+/)[0];
  if (!argv0) return false;
  const base = argv0.replace(/.*\//, "");
  return PORT_FORWARDER_NAMES.some(
    (name) => base === name || base.startsWith(`${name}-`) || (base.length >= 15 && name.startsWith(base)),
  );
}

/**
 * The one systemd unit shape Openship installs per deployment — the bare/systemd
 * supervisor's `openship-{deploymentId}.service`.
 *
 * Pinned to the `dep_` id prefix rather than a bare `openship-*` wildcard because the
 * control plane's own units share that namespace: `openship.service`, and a dev
 * install's `openship-dev.service` which a wildcard reads as a managed deployment
 * with id "dev" — and then offers to stop Openship itself.
 */
const MANAGED_DEPLOYMENT_UNIT_RE = /^openship-(dep_[A-Za-z0-9_-]+)\.service$/;

/**
 * The unit name the systemd supervisor installs for a deployment — the WRITER of the
 * convention {@link managedDeploymentIdFromUnit} reads back. Both live here because a
 * drift between them is silent and one-directional: the reader simply stops recognizing
 * the unit as Openship's and the deploy is told a stale deployment of its own is a
 * foreign process it must not touch.
 */
export function managedDeploymentUnitName(deploymentId: string): string {
  return `openship-${deploymentId}.service`;
}

/** The deployment id a unit name belongs to, or null if it isn't a deployment unit. */
export function managedDeploymentIdFromUnit(unit: string | undefined): string | null {
  return unit?.match(MANAGED_DEPLOYMENT_UNIT_RE)?.[1] ?? null;
}

/**
 * Units that must never be stopped for ANY reason we have: stopping them costs far
 * more than the port is worth. Container/VM supervisors and the rootless user manager
 * are a backstop — the forwarder check above should mean they are never proposed at
 * all — while ssh, the control plane's own units and the resolver/bus are cases the
 * forwarder check cannot cover (a real conflict on :22 or :53 resolves to them
 * honestly).
 */
const PROTECTED_UNITS = new Set([
  "docker",
  "docker.socket",
  "dockerd",
  "snap.docker.dockerd",
  "containerd",
  "containerd.socket",
  "podman",
  // Other container/VM supervisors whose forwarders land on their daemon unit.
  "lxd",
  "snap.lxd.daemon",
  "incus",
  "k3s",
  "k3s-agent",
  "kubelet",
  "libvirtd",
  "ssh",
  "sshd",
  "dbus",
  "systemd-resolved",
  "systemd-networkd",
  "systemd-logind",
  // The control plane itself, and a from-source dev install of it.
  "openship",
  "openship-dev",
]);

/** `user@1000.service` — the operator's entire session manager, and where a rootless
 *  daemon's forwarder lands. Never a port's owner. */
const USER_MANAGER_UNIT_RE = /^user@\d+$/;

/**
 * Classify a proxy from an image / command / unit string. Lives here, in the leaf, so
 * "is this a proxy" is ONE rule: the edge probe asks it of a container image and a
 * command line, and the unit gate below asks it of a systemd unit name. It was two
 * lists before — this function plus a separate set of unit names — which is one place
 * too many to remember when a new proxy shows up. Re-exported from `proxy/detect` for
 * its existing consumers, including the Docker migration scan.
 */
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

function bareUnit(unit: string): string {
  return unit.replace(/\.service$/, "");
}

function isProtectedUnit(unit: string): boolean {
  const bare = bareUnit(unit);
  return PROTECTED_UNITS.has(bare) || USER_MANAGER_UNIT_RE.test(bare);
}

/**
 * May this unit be stopped to free an APPLICATION port (deploy preflight)?
 *
 * A unit resolved from a `/proc/<pid>/cgroup` read is INFORMATION about a listener,
 * not a licence to stop it — so this is the single gate, and the caller must also have
 * established that the unit really is the port's owner (see
 * {@link isContainerPortForwarder}: for a published container port it never is).
 *
 * Openship's own per-deployment unit is always allowed. A genuine third-party service
 * — an `mysql.service` actually holding its port — stays allowed, because stopping it
 * is a real answer to a port conflict and the prompt names it. Proxies are NOT: on an
 * Openship host the proxy on :80 fronts every routed domain, so trading it for one
 * app's port is never what the operator meant.
 */
export function mayStopUnitForAppPort(unit: string | undefined): boolean {
  if (!unit) return false;
  if (managedDeploymentIdFromUnit(unit)) return true;
  // Stopping a proxy is the edge takeover's whole JOB — a bare host OpenResty is the
  // migration source it replaces — and is almost never right for an application deploy,
  // where the proxy holding :80 is the box's ingress for every routed domain. Hence two
  // gates rather than one shared verdict.
  return !isProtectedUnit(unit) && classifyProxy(bareUnit(unit)) === undefined;
}

/**
 * May this unit be stopped to take over the edge ports (80/443)?
 *
 * Same list minus the proxy exclusion: replacing a foreign proxy — including a legacy
 * bare-host OpenResty of ours — is the operation, and it happens only behind an
 * explicit, user-accepted EdgePolicy.
 */
export function mayStopUnitForEdgeTakeover(unit: string | undefined): boolean {
  if (!unit) return false;
  if (managedDeploymentIdFromUnit(unit)) return true;
  return !isProtectedUnit(unit);
}
