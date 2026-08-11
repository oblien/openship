/**
 * Proxy config import — read an existing reverse proxy's configuration and
 * normalize its sites so a migrate/takeover can re-register them as Openship
 * routes. All parsing is read-only and best-effort (warnings, never throws).
 */

import type { CommandExecutor } from "../../../types";
import type { ImportedSite, ProxyKind, ProxyScanResult } from "../../types";
import { EDGE_CONTAINER_MOUNTS } from "../../../infra/openresty-lua";
import { sq } from "../detect";
import { scanNginx, scanOpenshipEdge, scanForeignOpenResty } from "./nginx";
import { scanCaddy } from "./caddy";
import { scanApache } from "./apache";
import { scanTraefik } from "./traefik";

/**
 * Config markers that prove a proxy is INSTALLED on this host, checked in
 * priority order.
 *
 * OpenResty ON THE HOST is included, and that is the point: our edge is a
 * CONTAINER now, so a host OpenResty is a proxy to migrate FROM like any other —
 * including one an older Openship installed itself. This list used to exclude
 * `/usr/local/openresty/...` as "ours", which was true only while the bare edge WAS
 * us; the container edge's own config lives inside the image, and its host-side
 * state is the `/var/lib/openship/edge` bind mount, so a file at these paths means
 * a host install, never the container.
 *
 * Checked last so a box running both (host OpenResty + a distro nginx) reports the
 * more likely intentional one first.
 */
const INSTALLED_MARKERS: Array<{ proxy: ProxyKind; paths: string[] }> = [
  { proxy: "nginx", paths: ["/etc/nginx/nginx.conf"] },
  { proxy: "caddy", paths: ["/etc/caddy/Caddyfile"] },
  { proxy: "apache", paths: ["/etc/apache2/apache2.conf", "/etc/httpd/conf/httpd.conf"] },
  {
    proxy: "openresty",
    paths: ["/usr/local/openresty/nginx/conf/nginx.conf", "/etc/openresty/nginx.conf"],
  },
];

/**
 * Find a proxy that is installed on this host but is NOT currently serving
 * :80/:443 — i.e. one we already stopped.
 *
 * Why this exists: `probeEdge` can only see a proxy that HOLDS the ports, so once
 * a takeover stops the operator's nginx, its sites become invisible to the
 * migrate flow — even though every vhost is still sitting in /etc/nginx. A run
 * that stopped the proxy but failed to register its sites (or a re-run after
 * that) had no way to recover them, which is exactly how a box ends up serving
 * nothing for domains the operator was told would be migrated. The parsers read
 * config off disk and never touch the process, so a stopped proxy scans fine.
 *
 * Returns null when nothing importable is installed.
 */
export async function detectInstalledProxy(
  executor: CommandExecutor,
): Promise<ProxyKind | null> {
  const probe = INSTALLED_MARKERS.map(({ proxy, paths }) => {
    const test = paths.map((p) => `[ -f '${p}' ]`).join(" || ");
    return `{ ${test}; } && echo ${proxy}`;
  }).join("; ");
  let out = "";
  try {
    out = await executor.exec(`{ ${probe}; } 2>/dev/null; true`, { timeout: 10_000 });
  } catch {
    return null;
  }
  const found = new Set(
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return INSTALLED_MARKERS.find((m) => found.has(m.proxy))?.proxy ?? null;
}

/**
 * Scan a specific proxy's config into normalized sites. Returns an empty result
 * (with a warning) for proxies we can't import (e.g. haproxy — takeover-only).
 * traefik IS importable (via container labels) — see `scanTraefik`.
 */
export async function scanImportableSites(
  executor: CommandExecutor,
  proxy: ProxyKind,
): Promise<ProxyScanResult> {
  switch (proxy) {
    case "nginx":
      return scanNginx(executor);
    case "caddy":
      return scanCaddy(executor);
    case "apache":
      return scanApache(executor);
    case "traefik":
      return scanTraefik(executor);
    case "openresty":
      // A host OpenResty is a MIGRATION SOURCE — a legacy bare Openship edge or a
      // hand-rolled one. Dump its fully-resolved config so vhosts are found wherever
      // the install `include`s them; the fixed-glob read missed a non-default layout
      // and the migrate offer collapsed to takeover-only (dropping every live site).
      return scanForeignOpenResty(executor);
    default:
      return {
        proxy,
        sites: [],
        warnings: [`${proxy}: config import not supported — takeover only`],
      };
  }
}

/**
 * Which recognized proxies can we import config from?
 *
 * `openresty` is importable for the same reason the marker list includes it: with a
 * containerized edge, a host OpenResty is a migration SOURCE. Leaving it out meant
 * the one proxy whose config we can parse most reliably — our own former bare edge —
 * was offered "takeover only", i.e. drop every vhost it serves.
 */
export function canImportProxy(proxy: ProxyKind | undefined): boolean {
  return (
    proxy === "nginx" ||
    proxy === "caddy" ||
    proxy === "apache" ||
    proxy === "traefik" ||
    proxy === "openresty"
  );
}

export { scanNginx, scanOpenshipEdge, scanCaddy, scanApache, scanTraefik };

/** One adopted static site whose docroot the containerized edge cannot read. */
export interface UnreachableStaticRoot {
  /** Primary hostname (what the operator recognises). */
  host: string;
  /** The docroot as the foreign proxy declared it — a HOST path. */
  root: string;
}

/**
 * Adopted static sites whose docroot lives outside the edge container's bind
 * mounts — i.e. the paths the edge simply cannot see.
 *
 * A bare host proxy could serve any directory on the box; the containerized edge
 * only sees {@link EDGE_CONTAINER_MOUNTS}. Migrating `root /home/app/dist`
 * verbatim therefore produces a vhost that answers **500** (`try_files` →
 * `/index.html` → "rewrite or internal redirection cycle"), which reads as a
 * broken site rather than a missing mount. Surfacing this BEFORE the cutover lets
 * the caller offer the real choices: copy the tree under `/opt/openship/static`
 * (already mounted), add a bind mount, or knowingly leave it.
 *
 * Returns [] for a bare-host edge, where every path is readable already.
 */
export function unreachableStaticRoots(
  sites: ImportedSite[],
  opts: { containerEdge: boolean },
): UnreachableStaticRoot[] {
  if (!opts.containerEdge) return [];
  const visible = EDGE_CONTAINER_MOUNTS.map((m) => m.host.replace(/\/+$/, ""));
  const out: UnreachableStaticRoot[] = [];
  for (const site of sites) {
    if (site.target.kind !== "static") continue;
    const root = site.target.root.replace(/\/+$/, "");
    // Prefix match on a path BOUNDARY — `/opt/openship/staticstuff` is not
    // inside `/opt/openship/static`.
    const reachable = visible.some((v) => root === v || root.startsWith(`${v}/`));
    if (!reachable) out.push({ host: site.serverNames[0] ?? root, root: site.target.root });
  }
  return out;
}

/**
 * The edge's bind-mounted static dir (host path == container path), where copies
 * of adopted-but-unreachable static roots land so the containerized edge can
 * actually serve them. Derived from {@link EDGE_CONTAINER_MOUNTS} so it tracks
 * the baked mounts rather than hardcoding the path in two places.
 */
const EDGE_STATIC_MOUNT =
  EDGE_CONTAINER_MOUNTS.find((m) => m.host === "/opt/openship/static")?.host ??
  "/opt/openship/static";

/**
 * Copy an adopted static site's docroot INTO the edge's bind-mounted static dir
 * and return the new (container-visible) root. The migrate flow rewrites the
 * route's `staticRoot` to this value so the site keeps serving after cutover
 * instead of 500ing — see {@link unreachableStaticRoots}.
 *
 * The source is a HOST path the foreign proxy served (e.g. `/home/app/dist`) that
 * the edge container cannot see; the dest `/opt/openship/static/_adopted/<host>`
 * is inside {@link EDGE_CONTAINER_MOUNTS}, mounted at the SAME path inside the
 * container. This is a point-in-time SNAPSHOT: later changes to the original tree
 * do NOT propagate (the operator can re-copy or add a bind mount for live files).
 *
 * Copies CONTENTS (`<root>/.`) so files land directly under <dest>, matching the
 * `root <dest>;` the vhost emits. MUST run on the HOST executor (the only one that
 * sees both paths) — i.e. the CLI's LocalExecutor before `docker compose up`, not
 * the containerized API. Throws if the source is unreadable; callers treat a copy
 * failure as "leave this site as-is".
 */
export async function copyStaticRootIntoEdge(
  executor: CommandExecutor,
  opts: { root: string; host: string },
): Promise<string> {
  const slug =
    opts.host
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "site";
  const src = opts.root.replace(/\/+$/, "");
  const dest = `${EDGE_STATIC_MOUNT}/_adopted/${slug}`;
  await executor.exec(`mkdir -p ${sq(dest)}`);
  // `<src>/.` copies CONTENTS (incl. dotfiles) so files land directly under <dest>,
  // matching the `root <dest>;` the vhost emits; quote the whole argument so a path
  // with spaces stays one token.
  await executor.exec(`cp -a ${sq(`${src}/.`)} ${sq(`${dest}/`)}`);
  return dest;
}
