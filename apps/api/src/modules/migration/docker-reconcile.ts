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
import type { ComposeHealthcheck, ProxySettings } from "@repo/core";
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
  /** Content-addressable image ID (sha256:…) from the container inspect. Stable
   *  even when the `image` tag has drifted/been pruned — so it's the reliable
   *  ref for sizing, presence checks, and `docker save` (the tag can fail to
   *  resolve for a locally-built compose image). */
  imageId?: string;
  /** compose build context (set → adoption builds this Dockerfile). */
  build?: string;
  dockerfile?: string;
  /** compose-style "host:container[/proto]" strings, from actual bindings. */
  ports: string[];
  env: Record<string, string>;
  /** Env the container carries that provably came from the IMAGE, not the operator
   *  — recovered from Docker's create-time merge order (see
   *  {@link splitEnvByProvenance}). Not imported as explicit config (the same
   *  image re-supplies it at runtime), but carried with VALUES so the wizard can
   *  show exactly what was left behind and offer a one-click import (#394).
   *  Absent when nothing was left behind. */
  envImageDefaults?: Record<string, string>;
  volumes: DiscoveredVolumeMount[];
  networks: string[];
  dependsOn: string[];
  command?: string;
  /** #332: structured argv (from the live container's Cmd, or the declared
   *  compose command) so adoption re-runs the real Cmd, not a `sh -c`-wrapped
   *  string. `null` = use image CMD. */
  commandArgv?: string[] | null;
  restart?: string;
  healthcheck?: ComposeHealthcheck;
  /** Live cpu/memory caps the container is running with, so adoption preserves
   *  them instead of resetting to the project default. Undefined = uncapped. */
  resources?: { cpuCores?: number; memoryMb?: number };
  /** Reverse-proxy kind when this container IS the edge proxy (image/command
   *  matches AND it binds a host edge port). Openship's OpenResty replaces it,
   *  so it's dropped from import — importing it is the 80/443 conflict. */
  proxyKind?: ProxyKind;
  /** Host edge ports (80/443) this service publishes. Reserved for OpenResty:
   *  stripped from an imported non-proxy service; the signal that a proxy owns
   *  the edge. */
  edgePorts?: number[];
  /** Routes the server's EXISTING (foreign) reverse proxy already serves for this
   *  container, matched by published host port — so the wizard can show the
   *  current domain(s)+path+SSL and offer to keep them. ONE ENTRY PER (port,path):
   *  a container behind a path-fan-out domain (`/ → :1010`, `/v3 → :1020`) or with
   *  several published ports collects several. Absent = no proxied route detected. */
  existingRoute?: Array<{
    port: number;
    path: string;
    domains: string[];
    ssl: { enabled: boolean; certPath?: string; keyPath?: string };
    /** Adoptable reverse-proxy tunables the foreign vhost declared (upload limit,
     *  timeouts, …). Carried so the migrated project keeps the limits it already ran
     *  under instead of dropping to nginx's defaults on cutover. */
    proxy?: ProxySettings;
    source?: string;
  }>;
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
  /** Every route the foreign proxy serves, flattened (one per port+path). Lets the
   *  wizard SHOW each detected domain/path + its guessed service, so a fan-out
   *  path isn't silently dropped; unmatched ones also appear in `warnings`. */
  proxyRoutes: ExistingRoute[];
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

/** Cache key for a container's image data (env + default CMD). Prefers the
 *  content-addressed ID so a tag that has since MOVED (a rebuild, a retag) can't
 *  hand back a DIFFERENT image's defaults — which would silently drop real config
 *  or keep stale vars. Falls back to the tag when inspect reported no ID. */
export const imageRefKey = (detail: { imageId?: string; image?: string }): string =>
  detail.imageId ?? detail.image ?? "";

const envKey = (entry: string): string => {
  const eq = entry.indexOf("=");
  return eq > 0 ? entry.slice(0, eq) : entry;
};

/**
 * Recover which of a container's env vars the OPERATOR set, and which the image
 * merely baked in — by inverting Docker's create-time merge.
 *
 * The daemon (`daemon.merge`) builds `Config.Env` as:
 *
 *     [every var the client sent, in the client's order]
 *       ++ [image vars whose KEY the client did NOT send, in image order]
 *
 * So the operator's block is a PREFIX and image-only vars are appended after it.
 * That ordering is the provenance Docker records, and it's the only signal that
 * distinguishes `environment: NODE_ENV: production` in a compose file from `ENV
 * NODE_ENV=production` in the Dockerfile — the two produce a byte-identical
 * entry, so a set-membership test on KEY=VALUE cannot tell them apart and drops
 * real config (the #394 symptom: a service importing 1 env var out of 3).
 * `docker exec … env` is NOT a better source: it alphabetises the merged result
 * (destroying the ordering) and adds runtime-injected HOME/HOSTNAME.
 *
 * Reconstruction: find the smallest boundary `k` for which `containerEnv[k..]`
 * is EXACTLY `imageEnv` minus the keys in `containerEnv[0..k-1]` (full KEY=VALUE
 * compare, order included). Smallest, not largest: a container that carries the
 * image's env verbatim satisfies every `k` trivially, and taking the largest
 * would import the whole toolchain (NODE_VERSION, YARN_VERSION, …) as config.
 *
 * `recovered: false` = no boundary fits (a non-Docker runtime, or the image's env
 * changed after the container was created) → callers fall back to subtracting
 * exact KEY=VALUE matches.
 */
export function splitEnvByProvenance(
  containerEnv: string[],
  imageEnv: string[],
): { userEnv: string[]; imageOnly: string[]; recovered: boolean } {
  for (let k = 0; k <= containerEnv.length; k++) {
    const userKeys = new Set(containerEnv.slice(0, k).map(envKey));
    const expected = imageEnv.filter((e) => !userKeys.has(envKey(e)));
    if (expected.length !== containerEnv.length - k) continue;
    if (expected.every((e, i) => e === containerEnv[k + i])) {
      return {
        userEnv: containerEnv.slice(0, k),
        imageOnly: containerEnv.slice(k),
        recovered: true,
      };
    }
  }
  return { userEnv: containerEnv, imageOnly: [], recovered: false };
}

/**
 * Container env (`Config.Env`, in order) → the config Openship imports, plus the
 * vars it left behind because the image supplies them.
 *
 * `imageEnv` = the image's own ordered `Config.Env`. `declaredKeys` = keys the
 * compose file declares under `environment:` — operator config by definition, so
 * they are kept with the container's LIVE value (interpolation and `env_file`
 * already resolved) even when that value equals the image default.
 */
function envArrayToRecord(
  env: string[],
  imageEnv?: string[],
  declaredKeys?: Set<string>,
): { record: Record<string, string>; imageDefaults: Record<string, string> } {
  const { imageOnly, recovered } = imageEnv?.length
    ? splitEnvByProvenance(env, imageEnv)
    : { imageOnly: [] as string[], recovered: true };
  // Provenance recovered → only the appended block is image-supplied. Not
  // recovered → fall back to the old exact KEY=VALUE subtraction rather than
  // importing the image's whole toolchain.
  const imageSupplied = recovered ? new Set(imageOnly) : new Set(imageEnv ?? []);

  const out: Record<string, string> = {};
  const imageDefaults: Record<string, string> = {};
  for (const entry of env) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (ENV_DENYLIST.has(key)) continue;
    const value = entry.slice(eq + 1);
    if (imageSupplied.has(entry) && !declaredKeys?.has(key)) {
      imageDefaults[key] = value;
      continue;
    }
    out[key] = value;
  }
  return { record: out, imageDefaults };
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
 *  service. `imageEnv` = the image's own ORDERED `Config.Env`; the order is what
 *  makes operator-set vars separable from image-baked ones (see
 *  {@link splitEnvByProvenance}). */
/**
 * The compose-service IDENTITY for a discovered container — the name a migrated
 * service adopts. Priority:
 *   1. an explicit compose-file declaration (`declared.name`)
 *   2. the `com.docker.compose.service` label (a real compose stack)
 *   3. Openship's own `openship.service` label — Openship deploys compose
 *      services as plain dockerode containers (`openship-<slug>-<svc>`) that
 *      carry NO compose label, so without this step the moved service was named
 *      after the CONTAINER (`openship-openship-web`) and no longer matched its
 *      git-compose definition (`web`) → the reconcile created a DUPLICATE
 *      bare-name row instead of updating the moved one in place.
 *   4. the raw container name (last resort).
 */
export function discoveredServiceName(
  detail: { composeService?: string; labels?: Record<string, string>; name: string },
  declared: { name?: string } | undefined,
): string {
  return declared?.name ?? detail.composeService ?? detail.labels?.["openship.service"] ?? detail.name;
}

/**
 * Display-grouping key for an Openship-DEPLOYED container that carries no
 * compose label. Openship runs compose services as plain containers named
 * `openship-<slug>-<svc>` (labels `openship.project`/`openship.service`, but NO
 * `com.docker.compose.project`), so without this they all collapse into the
 * single "standalone" bucket — the exact symptom in flat-docker mode where a
 * moved stack (supabase / mongodb / …) showed as N loose containers instead of
 * one group. Derive the stack SLUG from the container name minus the EXACT
 * `openship.service` suffix (using the label makes it precise even for
 * hyphenated service names like `mongo-express`). Returns null when the
 * container isn't an Openship compose service (→ truly standalone).
 */
export function openshipStackName(
  containerName: string | undefined,
  serviceLabel: string | undefined,
): string | null {
  if (!containerName || !serviceLabel) return null;
  const stripped = containerName.replace(/^openship-/, "");
  const suffix = `-${serviceLabel}`;
  if (!stripped.endsWith(suffix)) return null;
  return stripped.slice(0, -suffix.length) || null;
}

export function toDiscoveredService(
  detail: DockerContainerDetail,
  declared: ComposeService | undefined,
  imageEnv?: string[],
  imageCmd?: string[],
  proxyRoutesByPort?: Map<number, ExistingRoute[]>,
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

  // Coolify injects every runtime variable explicitly and its Nixpacks builds
  // bake the same values into the image, so subtracting image defaults dropped
  // real configuration — often all of it. `coolify.managed` is stamped on every
  // container it manages (bootstrap/helpers/docker.php).
  const coolifyManaged = "coolify.managed" in detail.labels;
  if (coolifyManaged) {
    warnings.push(
      "Coolify build-time variables (and any BuildKit secrets) are absent from a running container, so they cannot be imported — re-enter them before rebuilding. Runtime variables, including shared, linked-resource and secret values, were imported.",
    );
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
  // #332: prefer the declared compose argv, else the container's live Cmd argv
  // (verbatim — no join/`sh -c`). Null when it merely restates the image CMD.
  const commandArgv =
    declared?.commandArgv ?? (isImageDefaultCmd ? null : (containerCmd ?? null));

  const healthcheck =
    declared?.advanced?.healthcheck ??
    (detail.healthcheck ? inspectHealthcheckToCompose(detail.healthcheck) : undefined);

  // Prefer what the compose file DECLARES; fall back to the container's live
  // HostConfig, which also captures a hand-applied `docker update --memory`.
  const resources = declared?.advanced?.resources ?? detail.resources;

  const name = discoveredServiceName(detail, declared);
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

  // Match every route the foreign proxy serves, across ALL published host ports —
  // no break, so a path-fan-out domain (its paths live on different ports) and a
  // multi-port container both collect all their routes.
  let existingRoute: DiscoveredService["existingRoute"];
  if (proxyRoutesByPort && proxyRoutesByPort.size > 0) {
    const routes: NonNullable<DiscoveredService["existingRoute"]> = [];
    // Iterate DISTINCT public ports. Docker publishes each host port on BOTH
    // IPv4 (0.0.0.0) and IPv6 (::), so detail.ports lists the same publicPort
    // twice — without deduping we'd push the same route (same domain) twice and
    // the wizard would show each domain doubled (and submit two identical
    // endpoints). proxyRoutesByPort already holds one entry per (port,path), so
    // visiting each port ONCE preserves path-fan-out while killing the IPv4/IPv6
    // double-count. (portsToComposeStrings already dedups the same way.)
    const publicPorts = [
      ...new Set(
        detail.ports
          .map((p) => p.publicPort)
          .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0),
      ),
    ];
    for (const port of publicPorts) {
      for (const hit of proxyRoutesByPort.get(port) ?? []) {
        routes.push({
          port: hit.port,
          path: hit.path,
          domains: hit.domains,
          ssl: hit.ssl,
          ...(hit.proxy ? { proxy: hit.proxy } : {}),
          source: hit.source,
        });
      }
    }
    if (routes.length > 0) existingRoute = routes;
  }

  // Coolify sets every runtime var explicitly, so its containers carry the image's
  // env verbatim in the same order — the one shape provenance can't resolve (every
  // boundary fits, see splitEnvByProvenance). Skip the split entirely and import
  // the lot; the label is the reliable signal.
  const { record: env, imageDefaults: envImageDefaults } = envArrayToRecord(
    detail.env,
    coolifyManaged ? undefined : imageEnv,
    declared ? new Set(Object.keys(declared.environment ?? {})) : undefined,
  );

  return {
    name,
    source: declared ? "compose" : "container",
    containerId: detail.id,
    containerName: detail.name,
    running: detail.state === "running",
    image,
    imageId: detail.imageId,
    build: declared?.build,
    dockerfile: declared?.dockerfile,
    ports,
    env,
    ...(Object.keys(envImageDefaults).length > 0 && { envImageDefaults }),
    volumes: mounts,
    networks: detail.networks,
    dependsOn: declared?.dependsOn ?? [],
    command,
    commandArgv,
    restart: detail.restart?.name || declared?.restart,
    healthcheck,
    resources,
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
  /** {@link imageRefKey} → the image's ORDERED `Config.Env`, used to separate
   *  operator-set vars from image-baked ones (skipped for Coolify-managed
   *  containers — see toDiscoveredService). */
  imageEnv?: Map<string, string[]>;
  /** {@link imageRefKey} → its baked-in default CMD tokens, dropped when the
   *  container only restates it (see toDiscoveredService). */
  imageCmds?: Map<string, string[]>;
  /** Openship projects recovered from the server (computed in the IO shell). */
  openshipProjects?: OpenshipProjectGroup[];
  /** published host port → route the foreign proxy already serves (from the
   *  IO-shell proxy scan). Attached per-service by matching published ports. */
  proxyRoutesByPort?: Map<number, ExistingRoute[]>;
}): DiscoveredStack {
  const { serverId, details, volumes, networks, declared, alreadyManaged, imageEnv, imageCmds, proxyRoutesByPort } = opts;

  const composeProjects = [
    ...new Set(details.map((d) => d.composeProject).filter((p): p is string => Boolean(p))),
  ];

  // Build each service alongside the group it belongs to, then group. Priority:
  // the real compose project → else the Openship stack slug (openship-deployed
  // services have no compose label, so this keeps a moved stack together instead
  // of flattening it into standalone) → else truly standalone (null).
  const built = details.map((d) => ({
    project:
      d.composeProject ??
      openshipStackName(d.name, d.labels?.["openship.service"]) ??
      null,
    service: toDiscoveredService(
      d,
      d.composeService ? declared.get(d.composeService) : undefined,
      imageEnv?.get(imageRefKey(d)),
      imageCmds?.get(imageRefKey(d)),
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

  // Every route the foreign proxy serves, flattened for the wizard's route review
  // (so a domain/path can be seen + reassigned, not silently dropped). A route
  // whose upstream port matches NO discovered service is UNMATCHED — surface it
  // as a warning so a fan-out path (e.g. api.onvo.me/v3 → an unselected/hidden
  // container) is never lost without the operator knowing.
  const proxyRoutes = [...(proxyRoutesByPort?.values() ?? [])].flat();
  const matchedPorts = new Set(services.flatMap((s) => (s.existingRoute ?? []).map((r) => r.port)));
  for (const r of proxyRoutes) {
    if (!matchedPorts.has(r.port)) {
      warnings.push(
        `Reverse-proxy route ${r.domains[0] ?? "?"}${r.path === "/" ? "" : r.path} → :${r.port} ` +
          `has no matching adopted service — it won't be published. Import the service on that port to keep it.`,
      );
    }
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
    proxyRoutes,
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
  /** {@link imageRefKey} → the image's ordered `Config.Env`. */
  imageEnv?: Map<string, string[]>;
  imageCmds?: Map<string, string[]>;
}): OpenshipProjectGroup[] {
  const { managedDetails, manifestById, knownHereIds, snapshotIds, imageEnv, imageCmds } = opts;

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
      const svc = toDiscoveredService(d, undefined, imageEnv?.get(imageRefKey(d)), imageCmds?.get(imageRefKey(d)));
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
