import { posix } from "node:path";
import { parseVolumeMount } from "@repo/core";

/**
 * Pure helpers for the build-first overlap cutover in
 * `DockerRuntime.deployServiceWorkload`.
 *
 * Overlap: start the replacement under a temporary name, wait until it serves,
 * publish the candidate's project-network alias, then retire the incumbent.
 * Replace (the upstream behaviour): stop and remove the incumbent
 * first, then create. Overlap is only safe when the two containers can run side
 * by side, so anything that could collide forces replace.
 */
export type CutoverConfig = {
  ports: string[];
  volumes: string[];
  publicPort?: number;
  slug: string;
  serviceName: string;
  deploymentId: string;
};

/** Env var holding the shared read/write mount opt-in list. */
export const CUTOVER_SHARED_VOLUMES_ENV = "OPENSHIP_CUTOVER_SHARED_VOLUMES";

/** Explicit host publish (hostPort:containerPort or ip:host:container). Bare "3000" is not a host collision. */
export function hasHostPortBindings(ports: string[]): boolean {
  return ports.some((p) => {
    const mapping = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : p;
    return mapping.includes(":");
  });
}

/** Temporary name for the replacement while the incumbent still serves. */
export function newcomerName(cfg: Pick<CutoverConfig, "deploymentId" | "serviceName">): string {
  const id = cfg.deploymentId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  return `openship-cutover-${id}-${cfg.serviceName}`;
}

export function stableName(cfg: Pick<CutoverConfig, "slug" | "serviceName">): string {
  return `openship-${cfg.slug}-${cfg.serviceName}`;
}

function normalizeDest(dest: string): string {
  return posix.normalize(dest).replace(/\/$/, "") || "/";
}

/**
 * Container destination of a read/write volume spec, or null when the spec is
 * read-only. Anonymous destinations are included: the deployment adapter must
 * resolve their persistent sources before deciding whether to overlap.
 */
export function rwVolumeDest(spec: string): string | null {
  const mount = parseVolumeMount(spec);
  return mount.options.includes("ro") || !mount.target.startsWith("/") || mount.target.includes(":")
    ? null
    : normalizeDest(mount.target);
}

/** Key used in the opt-in list: `<project-slug>/<service>:<container-destination>`. */
export function sharedVolumeKey(slug: string, serviceName: string, dest: string): string {
  return `${slug}/${serviceName}:${normalizeDest(dest)}`;
}

/**
 * Parse the shared-volume opt-in list. Entries are separated by whitespace or
 * commas and look like `<project-slug>/<service>:<container-destination>`.
 * Malformed entries are ignored, so a typo can only ever keep the safe default.
 */
export function parseSharedVolumeOptIn(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const entry of raw.split(/[\s,]+/)) {
    const m = entry.match(/^([^/\s:]+)\/([^/\s:]+):(\/\S*)$/);
    if (!m) continue;
    out.add(sharedVolumeKey(m[1]!, m[2]!, m[3]!));
  }
  return out;
}

/**
 * Inspect records identify the storage itself. Container destinations alone do
 * not: the same database volume can be mounted at a different path in the new
 * image, and unrelated volumes can have the same container path.
 */
export interface CutoverMount {
  Type?: string;
  Source?: string;
  Name?: string;
  Destination: string;
  RW?: boolean;
}

type StorageIdentity = { name?: string; path?: string };

function absolutePath(value: string | undefined): string | undefined {
  return value?.startsWith("/") && !value.includes(":") ? normalizeDest(value) : undefined;
}

function incumbentStorage(mount: CutoverMount): StorageIdentity | null {
  if (mount.Type === "tmpfs") return {};
  const path = absolutePath(mount.Source);
  const name = mount.Name || undefined;
  if ((mount.Type === "volume" && !name) || (mount.Type === "bind" && !path)) return null;
  return name || path ? { ...(name && { name }), ...(path && { path }) } : null;
}

function candidateStorage(source: string): StorageIdentity | null {
  const path = absolutePath(source);
  if (path) return { path };
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source) ? { name: source } : null;
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a === "/" || b === "/" || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function sharesStorage(a: StorageIdentity, b: StorageIdentity): boolean {
  return Boolean(
    (a.name && a.name === b.name) || (a.path && b.path && pathsOverlap(a.path, b.path)),
  );
}

interface CutoverStorageInput {
  incumbentMounts: readonly CutoverMount[];
  /** Complete, resolved binds, including inherited image and anonymous volumes. */
  volumes: readonly string[];
  slug: string;
  serviceName: string;
  sharedOptIn: ReadonlySet<string>;
}

function storageDecision(opts: CutoverStorageInput): { verified: boolean; clashes: string[] } {
  const live = opts.incumbentMounts.filter((mount) => mount.RW !== false).map(incumbentStorage);
  const clashes: string[] = [];
  let verified = true;
  for (const spec of opts.volumes) {
    const mount = parseVolumeMount(spec);
    if (mount.options.includes("ro")) continue;
    const dest = rwVolumeDest(spec);
    const storage = candidateStorage(mount.source);
    if (!dest || !storage || live.some((identity) => identity === null)) {
      verified = false;
      continue;
    }
    if (!live.some((identity) => identity && sharesStorage(identity, storage))) continue;
    if (opts.sharedOptIn.has(sharedVolumeKey(opts.slug, opts.serviceName, dest))) continue;
    if (!clashes.includes(dest)) clashes.push(dest);
  }
  return { verified, clashes };
}

/** Writable candidate destinations that share storage without an exact opt-in. */
export function clashingRwDestinations(opts: CutoverStorageInput): string[] {
  return storageDecision(opts).clashes;
}

export type CutoverDecision =
  | { mode: "overlap" }
  | {
      mode: "replace";
      reason:
        | "no-incumbent"
        | "host-ports"
        | "shared-namespaces"
        | "devices"
        | "storage-unverified"
        | "shared-rw-volume"
        | "resources-unconfigured"
        | "capacity-unavailable"
        | "insufficient-capacity";
      clashes?: string[];
    };

export interface CutoverInput extends CutoverStorageInput {
  incumbentRunning: boolean;
  ports: string[];
  networkMode?: string;
  pidMode?: string;
  hasDevices?: boolean;
  /** Saved user limits, never inferred or added by the overlap decision. */
  resources?: { cpuCores?: number; memoryMb?: number };
  /** Fresh matching-target headroom after the caller's existing reservations. */
  capacity?: { availableCpuCores: number; availableMemoryMb: number };
}

function finiteNonnegative(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function decideCutover(opts: CutoverInput): CutoverDecision {
  if (!opts.incumbentRunning) return { mode: "replace", reason: "no-incumbent" };
  if (hasHostPortBindings(opts.ports)) return { mode: "replace", reason: "host-ports" };
  if (opts.networkMode || opts.pidMode) return { mode: "replace", reason: "shared-namespaces" };
  if (opts.hasDevices) return { mode: "replace", reason: "devices" };
  const { verified, clashes } = storageDecision(opts);
  if (!verified) return { mode: "replace", reason: "storage-unverified" };
  if (clashes.length > 0) return { mode: "replace", reason: "shared-rw-volume", clashes };
  const cpu = opts.resources?.cpuCores;
  const memory = opts.resources?.memoryMb;
  if (!finiteNonnegative(cpu) || !finiteNonnegative(memory) || cpu === 0 || memory === 0)
    return { mode: "replace", reason: "resources-unconfigured" };
  const availableCpu = opts.capacity?.availableCpuCores;
  const availableMemory = opts.capacity?.availableMemoryMb;
  if (!finiteNonnegative(availableCpu) || !finiteNonnegative(availableMemory))
    return { mode: "replace", reason: "capacity-unavailable" };
  if (cpu > availableCpu || memory > availableMemory)
    return { mode: "replace", reason: "insufficient-capacity" };
  return { mode: "overlap" };
}
