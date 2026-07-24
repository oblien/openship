/**
 * Pure reconciliation for Docker discovery — NO IO (no SSH, no config, no
 * runtime). Merges inspected containers with declared compose services into a
 * normalized `DiscoveredStack`:
 *
 *   - compose is authoritative for build/source + declared dependsOn
 *   - `docker inspect` is authoritative for runtime truth (resolved named-volume
 *     names, actual published ports, live env, restart policy, health)
 *
 * Kept import-light so it's unit-testable with fixtures (see the IO shell in
 * docker-inspect.service.ts for the SSH/daemon side).
 */

import type {
  DockerContainerDetail,
  DockerMount,
  DockerNetworkInfo,
  DockerPortBinding,
  DockerVolumeInfo,
  ProxyKind,
} from "@repo/adapters";
import { classifyProxy } from "@repo/adapters";
import type { ComposeHealthcheck } from "@repo/core";
import type { ComposeService } from "../../lib/compose-parser";
import type { ManifestProjectEntry } from "../../lib/openship-manifest";
import type { ExistingRoute } from "./proxy-route-scan";

export interface DiscoveredVolumeMount {
  /** "volume" reuses a named volume in place; "bind" is a host path. */
  type: "volume" | "bind";
  /** Named-volume name (type=volume) or host path (type=bind). */
  source?: string;
  /** Path inside the container. */
  target: string;
  rw: boolean;
}

export interface DiscoveredService {
  /** compose service name, or the container name for a standalone container. */
  name: string;
  /** Where it was discovered — informs how much Openship can reconstruct. */
  source: "compose" | "container";
  containerId?: string;
  containerName?: string;
  running: boolean;
  image?: string;
  /** compose build context (set → adoption builds this Dockerfile). */
  build?: string;
  dockerfile?: string;
  /** compose-style "host:container[/proto]" strings, from actual bindings. */
  ports: string[];
  env: Record<string, string>;
  volumes: DiscoveredVolumeMount[];
  networks: string[];
  dependsOn: string[];
  command?: string;
  restart?: string;
  healthcheck?: ComposeHealthcheck;
  /** Reverse-proxy kind when this container IS the edge proxy (image/command
   *  matches AND it binds a host edge port). Openship's OpenResty replaces it,
   *  so it's dropped from import — importing it is the 80/443 conflict. */
  proxyKind?: ProxyKind;
  /** Host edge ports (80/443) this service publishes. Reserved for OpenResty:
   *  stripped from an imported non-proxy service; the signal that a proxy owns
   *  the edge. */
  edgePorts?: number[];
  /** A route the server's EXISTING (foreign) reverse proxy already serves for
   *  this container, matched by a published host port — so the wizard can show
   *  the current domain(s)+SSL and offer to keep them. Absent = no proxied route
   *  detected (or no foreign proxy). */
  existingRoute?: {
    domains: string[];
    ssl: { enabled: boolean; certPath?: string; keyPath?: string };
    source?: string;
  };
  warnings: string[];
}

/** Services grouped by origin — a compose project, or standalone (`project: null`). */
export interface DiscoveredGroup {
  /** compose project name, or null for hand-run containers. */
  project: string | null;
  services: DiscoveredService[];
}

/**
 * An OPENSHIP-owned project recovered from a server's live containers (matched by
 * the `openship.project` label) + its `.openship/manifest.json` entry. `knownHere`
 * = this project id already exists in the scanning instance's DB (genuinely
 * managed here → not re-importable, just counted). `knownHere: false` = orphaned:
 * the DB was reset (DR) or the server came from another Openship instance →
 * re-importable, preserving the original id/slug so the live containers re-attach.
 */
export interface OpenshipProjectGroup {
  /** Original Openship project id from the `openship.project` label. */
  projectId: string;
  /** Best-effort display name (manifest name/slug → compose project → derived). */
  suggestedName: string;
  /** Original slug (from the manifest) — preserved on re-import to keep URLs. */
  slug?: string;
  /** Domains from the manifest — restored as route state on re-import. */
  domains?: string[];
  /** Git source recovered from the manifest (restored on re-import). */
  source?: {
    gitProvider?: string | null;
    gitOwner?: string | null;
    gitRepo?: string | null;
    gitBranch?: string | null;
  };
  runtimeMode?: string | null;
  /** Whether this project id already exists in this instance's DB. */
  knownHere: boolean;
  /** A full recovery snapshot (`dumpSubgraph`) exists on the server → re-import
   *  restores it faithfully. False → best-effort reconstruction from live docker. */
  hasSnapshot: boolean;
  /** Deployment id from the label/manifest — carried for future live-status recovery. */
  deploymentId?: string;
  /** When this project was last deployed (manifest `updatedAt`) — a "last seen"
   *  hint in the UI. Absent when there's no manifest (label-only recovery). */
  updatedAt?: string;
  /** Live service containers reconstructed from runtime state. */
  services: DiscoveredService[];
}

export interface DiscoveredStack {
  serverId: string;
  /** compose "project" groupings found (com.docker.compose.project). */
  composeProjects: string[];
  /** Services grouped for display: each compose stack, then standalone last. */
  groups: DiscoveredGroup[];
  /** Flat view of every discovered service (same objects as in `groups`). */
  services: DiscoveredService[];
  volumes: Array<{ name: string; driver: string; inUseBy: string[] }>;
  networks: Array<{ name: string; driver: string }>;
  /** Stack-level notes for things Openship can't carry over 1:1. */
  warnings: string[];
  adoptable: boolean;
  /** Live containers already managed by a project in THIS instance's DB (count). */
  alreadyManaged: number;
  /** Openship projects recovered from the server (see {@link OpenshipProjectGroup});
   *  `knownHere: false` entries are re-importable. Empty when none found. */
  openshipProjects: OpenshipProjectGroup[];
}

// Docker-injected / shell env that should never be imported as app config.
const ENV_DENYLIST = new Set([
  "PATH",
  "HOSTNAME",
  "HOME",
  "TERM",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "container",
]);

/** Networks Docker/compose create implicitly — never a "custom topology". */
export function isDefaultNetwork(name: string, composeProjects: string[]): boolean {
  if (name === "bridge" || name === "host" || name === "none") return true;
  return composeProjects.some((p) => name === `${p}_default`) || name === "default";
}

function envArrayToRecord(env: string[], imageDefaults?: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of env) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (ENV_DENYLIST.has(key)) continue;
    // Drop entries identical to the image's baked-in default (exact KEY=VALUE),
    // so an overridden var survives but the base image's dozen defaults don't
    // masquerade as user config. Without image data, nothing is dropped.
    if (imageDefaults?.has(entry)) continue;
    out[key] = entry.slice(eq + 1);
  }
  return out;
}

function portsToComposeStrings(ports: DockerPortBinding[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of ports) {
    const proto = p.type && p.type !== "tcp" ? `/${p.type}` : "";
    // Preserve a non-wildcard host IP (e.g. a 127.0.0.1-only publish) so the
    // redeploy doesn't silently widen a loopback binding to all interfaces.
    const hostIp = p.ip && p.ip !== "0.0.0.0" && p.ip !== "::" ? `${p.ip}:` : "";
    const spec = p.publicPort
      ? `${hostIp}${p.publicPort}:${p.privatePort}${proto}`
      : `${p.privatePort}${proto}`;
    if (!seen.has(spec)) {
      seen.add(spec);
      out.push(spec);
    }
  }
  return out;
}

/** The host ports Openship's OpenResty edge owns — never re-published by an
 *  imported workload. */
export const EDGE_PORTS = new Set([80, 443]);

/** Parse a compose "host:container[/proto]" (or bare "container") port spec.
 *  `host` is the published host port (null for a bare container port — no host
 *  publish). Single source of truth for both edge detection and stripping;
 *  tolerates an optional host IP ("127.0.0.1:80:80"). */
export function parseComposePort(spec: string): {
  host: number | null;
  container: string;
  proto?: string;
} {
  const [hostAndPorts, proto] = spec.split("/");
  const parts = hostAndPorts.split(":");
  const container = parts[parts.length - 1];
  const host = parts.length >= 2 ? Number(parts[parts.length - 2]) : NaN;
  return { host: Number.isFinite(host) ? host : null, container, proto };
}

/** Host edge ports (80/443) a service publishes — the conflict signal. */
function edgePortsFromCompose(ports: string[]): number[] {
  const found = new Set<number>();
  for (const spec of ports) {
    const { host } = parseComposePort(spec);
    if (host != null && EDGE_PORTS.has(host)) found.add(host);
  }
  return [...found];
}

function toDiscoveredMounts(mounts: DockerMount[]): DiscoveredVolumeMount[] {
  return mounts
    .filter((m) => m.type === "volume" || m.type === "bind")
    .map((m) => ({
      type: m.type === "bind" ? "bind" : "volume",
      source: m.name ?? m.source,
      target: m.destination,
      rw: m.rw,
    }));
}

/** Docker healthcheck (durations in ns) → compose healthcheck (duration strings). */
function inspectHealthcheckToCompose(
  hc: NonNullable<DockerContainerDetail["healthcheck"]>,
): ComposeHealthcheck | undefined {
  if (!hc.test || hc.test.length === 0) return undefined;
  const [kind, ...rest] = hc.test;
  if (kind === "NONE") return { disable: true };
  const ns = (v?: number): string | undefined =>
    typeof v === "number" && v > 0 ? `${Math.round(v / 1_000_000_000)}s` : undefined;
  return {
    // CMD-SHELL → single shell string; CMD → argv; bare → treat as argv.
    test: kind === "CMD-SHELL" ? rest[0] : kind === "CMD" ? rest : hc.test,
    interval: ns(hc.interval),
    timeout: ns(hc.timeout),
    retries: hc.retries,
    startPeriod: ns(hc.startPeriod),
  };
}

/** Merge one container's inspect truth with its (optional) declared compose
 *  service. `imageDefaults` = the image's baked-in "KEY=VALUE" env, subtracted
 *  so only user-set vars are imported. */
export function toDiscoveredService(
  detail: DockerContainerDetail,
  declared: ComposeService | undefined,
  imageDefaults?: Set<string>,
  imageCmd?: string[],
  proxyRoutesByPort?: Map<number, ExistingRoute>,
): DiscoveredService {
  const mounts = toDiscoveredMounts(detail.mounts);
  const warnings: string[] = [];
  for (const m of mounts) {
    if (m.type === "bind") {
      warnings.push(
        `Bind mount ${m.source ?? "?"} → ${m.target}: data stays on the host, not migrated as a volume.`,
      );
    }
  }

  // Drop the container's command when it merely restates the image's default
  // CMD (and compose didn't declare one). Re-specifying it means the deploy
  // re-runs it wrapped as `sh -c "<cmd>"`, which defeats entrypoints that drop
  // privileges by argv — postgres then runs as root and refuses to start. A
  // genuine override (e.g. `redis-server --appendonly yes`) differs → kept.
  const containerCmd = detail.command && detail.command.length > 0 ? detail.command : undefined;
  const isImageDefaultCmd =
    !declared?.command &&
    !!containerCmd &&
    !!imageCmd &&
    containerCmd.length === imageCmd.length &&
    containerCmd.every((tok, i) => tok === imageCmd[i]);
  const command =
    declared?.command ?? (isImageDefaultCmd ? undefined : containerCmd?.join(" "));

  const healthcheck =
    declared?.advanced?.healthcheck ??
    (detail.healthcheck ? inspectHealthcheckToCompose(detail.healthcheck) : undefined);

  const name = declared?.name ?? detail.composeService ?? detail.name;
  const image = detail.image || declared?.image;
  const ports = portsToComposeStrings(detail.ports);

  // A container is the EDGE proxy only when it both publishes a host edge port
  // AND classifies as a proxy — so an internal `nginx` sidecar (no 80/443) is
  // left alone and only the thing actually holding the edge is dropped.
  const edgePorts = edgePortsFromCompose(ports);
  const proxyKind =
    edgePorts.length > 0
      ? classifyProxy([image, command, name].filter(Boolean).join(" "))
      : undefined;

  // Match a route the foreign proxy already serves, by any published host port.
  let existingRoute: DiscoveredService["existingRoute"];
  if (proxyRoutesByPort && proxyRoutesByPort.size > 0) {
    for (const p of detail.ports) {
      if (!p.publicPort) continue;
      const hit = proxyRoutesByPort.get(p.publicPort);
      if (hit) {
        existingRoute = { domains: hit.domains, ssl: hit.ssl, source: hit.source };
        break;
      }
    }
  }

  return {
    name,
    source: declared ? "compose" : "container",
    containerId: detail.id,
    containerName: detail.name,
    running: detail.state === "running",
    image,
    build: declared?.build,
    dockerfile: declared?.dockerfile,
    ports,
    env: envArrayToRecord(detail.env, imageDefaults),
    volumes: mounts,
    networks: detail.networks,
    dependsOn: declared?.dependsOn ?? [],
    command,
    restart: detail.restart?.name || declared?.restart,
    healthcheck,
    proxyKind,
    edgePorts: edgePorts.length > 0 ? edgePorts : undefined,
    existingRoute,
    warnings,
  };
}

/**
 * Pure reconciliation: merge inspected containers with declared compose
 * services into a DiscoveredStack. No IO — unit-testable with fixtures.
 */
export function reconcileStack(opts: {
  serverId: string;
  details: DockerContainerDetail[];
  volumes: DockerVolumeInfo[];
  networks: DockerNetworkInfo[];
  declared: Map<string, ComposeService>;
  alreadyManaged: number;
  /** image ref → its baked-in "KEY=VALUE" env, subtracted from container env. */
  imageDefaults?: Map<string, Set<string>>;
  /** image ref → its baked-in default CMD tokens, dropped when the container
   *  only restates it (see toDiscoveredService). */
  imageCmds?: Map<string, string[]>;
  /** Openship projects recovered from the server (computed in the IO shell). */
  openshipProjects?: OpenshipProjectGroup[];
  /** published host port → route the foreign proxy already serves (from the
   *  IO-shell proxy scan). Attached per-service by matching published ports. */
  proxyRoutesByPort?: Map<number, ExistingRoute>;
}): DiscoveredStack {
  const { serverId, details, volumes, networks, declared, alreadyManaged, imageDefaults, imageCmds, proxyRoutesByPort } = opts;

  const composeProjects = [
    ...new Set(details.map((d) => d.composeProject).filter((p): p is string => Boolean(p))),
  ];

  // Build each service alongside the compose project it belongs to, then group.
  const built = details.map((d) => ({
    project: d.composeProject ?? null,
    service: toDiscoveredService(
      d,
      d.composeService ? declared.get(d.composeService) : undefined,
      imageDefaults?.get(d.image),
      imageCmds?.get(d.image),
      proxyRoutesByPort,
    ),
  }));
  const services = built.map((b) => b.service);

  const byProject = new Map<string | null, DiscoveredService[]>();
  for (const b of built) {
    const arr = byProject.get(b.project) ?? [];
    arr.push(b.service);
    byProject.set(b.project, arr);
  }
  const groups: DiscoveredGroup[] = [...byProject.entries()]
    .map(([project, svcs]) => ({ project, services: svcs }))
    // Compose stacks first (named), standalone containers last.
    .sort((a, b) => (a.project === null ? 1 : 0) - (b.project === null ? 1 : 0));

  // Volumes actually mounted by adoptable services → what adoption must reuse.
  const inUse = new Map<string, Set<string>>();
  for (const svc of services) {
    for (const mount of svc.volumes) {
      if (mount.type !== "volume" || !mount.source) continue;
      const set = inUse.get(mount.source) ?? new Set<string>();
      set.add(svc.name);
      inUse.set(mount.source, set);
    }
  }
  const volumesOut = volumes
    .filter((v) => inUse.has(v.name))
    .map((v) => ({ name: v.name, driver: v.driver, inUseBy: [...(inUse.get(v.name) ?? [])] }));

  // Stack-level warnings for topology Openship flattens or can't model.
  const warnings: string[] = [];
  const customNetworks = networks
    .map((n) => n.name)
    .filter((name) => !isDefaultNetwork(name, composeProjects))
    .filter((name) => services.some((s) => s.networks.includes(name)));
  if (customNetworks.length > 0) {
    warnings.push(
      `Openship runs all services on one project network; custom networks (${customNetworks.join(", ")}) will be flattened. Services still reach each other by name.`,
    );
  }
  if (composeProjects.length > 0 || declared.size > 0) {
    warnings.push(
      "Compose `configs`, `secrets`, `expose`, and `depends_on` conditions are not modeled by Openship and won't carry over.",
    );
  }
  if (services.some((s) => Object.keys(s.env).length > 0)) {
    warnings.push(
      "Imported environment is read from the running containers and may include image defaults — review before adopting.",
    );
  }

  return {
    serverId,
    composeProjects,
    groups,
    services,
    volumes: volumesOut,
    networks: networks.map((n) => ({ name: n.name, driver: n.driver })),
    warnings,
    adoptable: services.length > 0,
    alreadyManaged,
    openshipProjects: opts.openshipProjects ?? [],
  };
}

/**
 * A TRANSIENT build-helper container — not a live app. The `openship.build`
 * label alone is NOT sufficient: it's baked into every locally-built image
 * (`openship/<app>:bld_…`) and Docker inherits image labels onto the running
 * container, so real deploy containers carry it too. A genuine build helper has
 * `openship.build` but NO `openship.deployment`/`openship.service` (those are
 * set only when a real app container is created). Used to keep transient
 * builders out of both the adopt grid and the re-import set without dropping the
 * real (locally-built) app containers.
 */
export const isBuildHelper = (labels: Record<string, string>) =>
  !!labels["openship.build"] && !labels["openship.deployment"] && !labels["openship.service"];

/**
 * Reconstruct OPENSHIP-owned projects from their live containers + the server's
 * `.openship/manifest.json`. Pure — the DB cross-reference (which ids are
 * `knownHere`) and the manifest read happen in the IO shell and are passed in.
 *
 * Containers are grouped by their `openship.project` label. Build-helper
 * containers (`openship.build`, no live app) are skipped. A single-app deploy
 * container carries only `openship.project`/`openship.deployment` (no
 * `openship.service`), so we DON'T require a service label — we recover the
 * service name from `openship.service` when present, else the container name.
 */
export function reconcileOpenshipProjects(opts: {
  managedDetails: DockerContainerDetail[];
  /** Manifest entries keyed by project id (null when the server has no manifest). */
  manifestById: Map<string, ManifestProjectEntry> | null;
  /** Project ids that already exist in this instance's DB. */
  knownHereIds: Set<string>;
  /** Project ids with a full recovery snapshot on the server (faithful restore). */
  snapshotIds: Set<string>;
  imageDefaults?: Map<string, Set<string>>;
  imageCmds?: Map<string, string[]>;
}): OpenshipProjectGroup[] {
  const { managedDetails, manifestById, knownHereIds, snapshotIds, imageDefaults, imageCmds } = opts;

  const byProject = new Map<string, DockerContainerDetail[]>();
  for (const d of managedDetails) {
    const projectId = d.labels["openship.project"];
    if (!projectId) continue; // not project-owned (infra/network helper) — skip
    if (isBuildHelper(d.labels)) continue; // transient build container — not a service
    const list = byProject.get(projectId) ?? [];
    list.push(d);
    byProject.set(projectId, list);
  }

  const out: OpenshipProjectGroup[] = [];
  for (const [projectId, details] of byProject) {
    const entry = manifestById?.get(projectId);
    const services = details.map((d) => {
      const svc = toDiscoveredService(d, undefined, imageDefaults?.get(d.image ?? ""), imageCmds?.get(d.image ?? ""));
      const serviceLabel = d.labels["openship.service"];
      return serviceLabel ? { ...svc, name: serviceLabel } : svc;
    });
    const deploymentId =
      details.find((d) => d.labels["openship.deployment"])?.labels["openship.deployment"] ??
      entry?.deployment?.id;

    out.push({
      projectId,
      knownHere: knownHereIds.has(projectId),
      hasSnapshot: snapshotIds.has(projectId),
      suggestedName:
        entry?.name ||
        entry?.slug ||
        details.find((d) => d.composeProject)?.composeProject ||
        `openship-${projectId.replace(/^proj_/, "").slice(0, 8)}`,
      slug: entry?.slug,
      domains: entry?.domains,
      source: entry
        ? {
            gitProvider: entry.gitProvider,
            gitOwner: entry.gitOwner,
            gitRepo: entry.gitRepo,
            gitBranch: entry.gitBranch,
          }
        : undefined,
      runtimeMode: entry?.runtimeMode ?? undefined,
      deploymentId,
      updatedAt: entry?.updatedAt,
      services,
    });
  }
  return out;
}
