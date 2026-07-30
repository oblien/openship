/**
 * Migration preflight — a read-only preview of what migrating the selected
 * services from a source server onto a target server will do. Classifies each
 * service (registry vs build), lists the named volumes that will move, and
 * surfaces the bind-mount / custom-network / downtime caveats BEFORE anything
 * changes. Reuses discoverServerStack (server truth). No mutation.
 *
 * v1: built-from-source services (compose `build:`, no registry image) are
 * BLOCKED — the adopted project has no linked source to rebuild on the target.
 */

import { edgeProxy } from "@repo/adapters";
import { discoverServerStack } from "./docker-inspect.service";
import { createServerCommandExecutor } from "../../lib/deployment-runtime";
import { sshManager } from "../../lib/ssh-manager";
import { sizeOfMoveSet, type SizedItem } from "./migration-size";
import { sq } from "./direct-transfer";

/**
 * Which bind-mount host paths are worth (and safe to) copy across servers.
 * App data dirs move; sockets, devices, and system paths never do — copying
 * `/var/run/docker.sock` or `/etc/localtime` onto the target is meaningless or
 * harmful. Shared by the orchestrator's move step and the preview.
 */
export function isMovableBind(hostPath: string | undefined): boolean {
  const p = (hostPath ?? "").trim();
  if (!p || p === "/" || !p.startsWith("/")) return false;
  if (p.endsWith(".sock")) return false;
  const denyPrefixes = ["/proc", "/sys", "/dev", "/run", "/var/run"];
  if (denyPrefixes.some((d) => p === d || p.startsWith(`${d}/`))) return false;
  const denyExact = new Set([
    "/etc/localtime",
    "/etc/timezone",
    "/etc/hosts",
    "/etc/hostname",
    "/etc/resolv.conf",
    "/var/lib/docker",
  ]);
  return !denyExact.has(p);
}

export interface MigrationPreviewService {
  name: string;
  source: "compose" | "container";
  image?: string;
  classification: "registry" | "build";
  /** Built-from-source → can't migrate in v1. */
  blocked: boolean;
  reason?: string;
  /** This service IS the edge proxy (80/443) → dropped from import; Openship's
   *  OpenResty replaces it and reclaims the port. */
  edgeProxy?: boolean;
  /** Non-proxy service that published 80/443 → those host bindings are stripped
   *  (reserved for Openship's edge); the app is routed through OpenResty. */
  edgePortsReserved?: number[];
  /** Named volumes that will be copied (cross-server) / reused (same-server). */
  volumes: Array<{ name: string; target: string }>;
  /** App-data bind-mount host paths that WILL be copied to the target. */
  bindMounts: string[];
  /** System/socket bind paths left on the source host (never copied). */
  bindMountsSkipped: string[];
  warnings: string[];
}

export interface MigrationPreview {
  sameServer: boolean;
  services: MigrationPreviewService[];
  /** Distinct named volumes to move (empty for same-server). */
  volumesToMove: string[];
  /** Any selected service is build-only → the migration can't run as-is. */
  hasBlocked: boolean;
  /** A stop-copy-start window applies (originals are stopped during the move). */
  downtimeWarning: boolean;
  /** Reverse-proxy services that will NOT be imported (Openship's edge replaces
   *  them). They're left running and untouched by the migration; add a domain to
   *  a migrated service to move onto Openship's edge (its consent modal reclaims
   *  80/443 then). */
  droppedProxies: string[];
  /** Stack-level notes (custom networks flattened, etc.). */
  warnings: string[];
  /** Cross-server transfer plan: the measured payload (per volume/bind/image)
   *  and its total, for the wizard's "how many GB" step + the progress-bar
   *  denominator. Absent for same-server (nothing moves). `partial` = at least
   *  one item couldn't be sized, so `totalBytes` is a lower bound. */
  plan?: {
    totalBytes: number;
    partial: boolean;
    items: SizedItem[];
  };
  /** Per kept domain, whether the source proxy has a reusable on-disk cert that
   *  will be CARRIED (reused, no ACME). `false` → the target issues via ACME on
   *  publish (e.g. Traefik acme.json, or no cert). Cross-server only. */
  sslByDomain?: Array<{ domain: string; hasCert: boolean }>;
  /** Cross-server: each target VOLUME that already holds data (keyed by the
   *  unique volume name — two services can share a display name, so per-volume
   *  is the isolation unit). The user resolves each (override/clone/keep) at the
   *  plan step before the migrate can run. */
  conflicts?: Array<{ serviceName: string; volume: string }>;
}

/**
 * Ask the source server's proxy, for each domain a kept service currently serves,
 * whether it holds a cert we can actually carry. `hasCert: false` means the target
 * will issue via ACME on publish.
 *
 * One SSH pass with one proxy scan behind it (`edgeProxy` memoizes), then one cert
 * lookup per domain. Best-effort: an unreachable source or a failed scan reports
 * `hasCert: false` for everything, which is the safe direction — the wizard says
 * "will issue" and the carry can still surprise the operator pleasantly.
 */
async function previewSslByDomain(
  sourceServerId: string,
  chosen: Array<{ proxyKind?: unknown; existingRoute?: Array<{ ssl: { enabled: boolean }; domains: string[] }> }>,
): Promise<Array<{ domain: string; hasCert: boolean }> | undefined> {
  const tlsDomains = new Set<string>();
  const plainDomains = new Set<string>();
  for (const s of chosen) {
    if (s.proxyKind) continue;
    for (const r of s.existingRoute ?? []) {
      for (const d of r.domains) (r.ssl?.enabled ? tlsDomains : plainDomains).add(d);
    }
  }
  const all = new Set([...tlsDomains, ...plainDomains]);
  if (all.size === 0) return undefined;

  const carried = new Set<string>();
  try {
    await sshManager.withExecutor(sourceServerId, async (exec) => {
      const proxy = await edgeProxy(exec);
      if (!proxy) return;
      for (const domain of tlsDomains) {
        if (await proxy.certFor(domain).catch(() => null)) carried.add(domain);
      }
    });
  } catch {
    // Source unreachable — every domain reports "will issue".
  }
  return [...all].map((domain) => ({ domain, hasCert: carried.has(domain) }));
}

export async function buildMigrationPreview(opts: {
  sourceServerId: string;
  targetServerId: string;
  serviceNames: string[];
  organizationId: string;
  /** User-selected extra paths to move (sized in the plan). */
  customPaths?: Array<{ source: string; dest: string }>;
}): Promise<MigrationPreview> {
  const { sourceServerId, targetServerId, serviceNames, organizationId } = opts;
  const customPaths = opts.customPaths ?? [];

  const stack = await discoverServerStack(sourceServerId, organizationId);
  const selected = new Set(serviceNames);
  const chosen = stack.services.filter((s) => selected.has(s.name));
  const sameServer = sourceServerId === targetServerId;

  const services: MigrationPreviewService[] = chosen.map((s) => {
    // Build-only = has a build context and no runnable registry image.
    const isBuild = Boolean(s.build) && !s.image;
    const isProxy = Boolean(s.proxyKind);
    const volumes = s.volumes
      .filter((v) => v.type === "volume" && v.source)
      .map((v) => ({ name: v.source as string, target: v.target }));
    const bindAll = s.volumes
      .filter((v) => v.type === "bind" && v.source)
      .map((v) => v.source as string);
    return {
      name: s.name,
      source: s.source,
      image: s.image,
      classification: isBuild ? "build" : "registry",
      blocked: isBuild,
      reason: isBuild
        ? "Built-from-source services can't be migrated yet — publish an image or link a repo first."
        : isProxy
          ? `Reverse proxy (${s.proxyKind}) on ${(s.edgePorts ?? []).map((p) => `:${p}`).join("/")} — Openship's edge replaces it; not imported.`
          : undefined,
      edgeProxy: isProxy || undefined,
      edgePortsReserved: !isProxy && s.edgePorts?.length ? s.edgePorts : undefined,
      volumes,
      bindMounts: bindAll.filter(isMovableBind),
      bindMountsSkipped: bindAll.filter((p) => !isMovableBind(p)),
      warnings: s.warnings,
    };
  });

  // Proxies are dropped, not migrated — exclude them from the moved-volume set.
  const workloads = services.filter((s) => !s.edgeProxy);
  const droppedProxies = services.filter((s) => s.edgeProxy).map((s) => s.name);
  const volumesToMove = sameServer
    ? []
    : Array.from(new Set(workloads.flatMap((s) => s.volumes.map((v) => v.name))));

  // Per kept domain: will the source proxy's cert be CARRIED (no ACME)?
  //
  // This asks the same reader the migration itself uses, rather than checking for
  // declared cert paths. The paths-present test was wrong in both directions: it
  // said "will reuse" for a path holding an expired or wrong-hostname cert that
  // the carry then rejects, and "will issue" for every caddy and traefik box —
  // those keep certs in their own stores with no path to declare, so the wizard
  // promised an ACME issuance for domains whose certs are sitting right there.
  const sslByDomain = sameServer ? undefined : await previewSslByDomain(sourceServerId, chosen);

  // Cross-server: measure the payload on the source (volumes + movable binds +
  // built images by ID + custom paths) so the wizard can show total GB and a
  // real-% bar. Same-server moves nothing, so skip. Best-effort — a sizing
  // failure just omits `plan`, never blocks the preview.
  let plan: MigrationPreview["plan"];
  if (!sameServer && (workloads.length > 0 || customPaths.length > 0)) {
    const bindPaths = Array.from(new Set(workloads.flatMap((s) => s.bindMounts)));
    const builtImages = [
      ...new Map(
        chosen
          .filter((s) => !s.proxyKind && Boolean(s.build) && s.image)
          .map((s) => {
            const tag = s.image as string;
            const id = s.imageId ?? tag;
            return [id, { id, tag }] as const;
          }),
      ).values(),
    ];
    try {
      const { executor } = await createServerCommandExecutor(sourceServerId, organizationId);
      const sized = await sizeOfMoveSet(executor, {
        volumeNames: volumesToMove,
        bindPaths,
        images: builtImages,
        customPaths: customPaths.map((c) => c.source),
      });
      plan = { totalBytes: sized.totalBytes, partial: sized.partial, items: sized.perItem };
    } catch {
      /* sizing is best-effort — leave `plan` undefined */
    }
  }

  // Cross-server: which target volumes already hold data? Surfaced up front so
  // the user resolves each (override / clone / keep) at the plan step instead of
  // hitting the run-time "refusing to overwrite" hard-fail. Best-effort — a
  // probe hiccup just omits the conflict (the run-time guard is the backstop).
  let conflicts: MigrationPreview["conflicts"];
  if (!sameServer && volumesToMove.length > 0) {
    try {
      const { executor } = await createServerCommandExecutor(targetServerId, organizationId);
      const hasData = new Set<string>();
      for (const name of volumesToMove) {
        const out = await executor
          .exec(
            `if docker volume inspect ${sq(name)} >/dev/null 2>&1; then ` +
              `mp=$(docker volume inspect ${sq(name)} -f '{{.Mountpoint}}'); ` +
              `[ -n "$(ls -A "$mp" 2>/dev/null)" ] && echo CONFLICT || true; fi`,
          )
          .catch(() => "");
        if (out.includes("CONFLICT")) hasData.add(name);
      }
      if (hasData.size > 0) {
        // Flatten to one entry PER VOLUME — the unique isolation unit (two
        // services can share a display name; volume names can't collide).
        const flat: Array<{ serviceName: string; volume: string }> = [];
        for (const s of workloads) {
          for (const v of s.volumes) {
            if (hasData.has(v.name)) flat.push({ serviceName: s.name, volume: v.name });
          }
        }
        if (flat.length > 0) conflicts = flat;
      }
    } catch {
      /* best-effort — leave `conflicts` undefined */
    }
  }

  return {
    sameServer,
    services,
    volumesToMove,
    hasBlocked: workloads.some((s) => s.blocked),
    downtimeWarning: workloads.length > 0,
    droppedProxies,
    warnings: stack.warnings,
    ...(plan ? { plan } : {}),
    ...(sslByDomain ? { sslByDomain } : {}),
    ...(conflicts ? { conflicts } : {}),
  };
}
