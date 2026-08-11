import { repos, type Project } from "@repo/db";
import { env } from "../config/env";

interface DeploymentSnapshotLike {
  serverId?: string;
}

/**
 * Resolve a server's host (IP/hostname) for an org. Refuses to read
 * server rows that belong to a different organization than the caller —
 * defense against a caller smuggling a foreign org's serverId through
 * a request body to route their managed subdomain at another tenant's
 * host.
 *
 * Falls back to env.SERVER_IP when no serverId is supplied.
 *
 * Returns `sshHost` RAW. For the local "This Server" row that field is
 * DISPLAY-only (`SERVER_IP || HOST_DOMAIN || "127.0.0.1"`), so every caller that
 * hands the result to something else — a container's env, DNS guidance, an edge
 * target — must reject loopback itself via {@link isLoopbackHost}.
 */
async function resolveSnapshotServerHost(
  organizationId: string,
  snapshot?: DeploymentSnapshotLike | null,
): Promise<string | null> {
  if (snapshot?.serverId) {
    const server = await repos.server.getInOrganization(
      snapshot.serverId,
      organizationId,
    );
    if (server?.sshHost) return server.sshHost;
    return null;
  }

  return env.SERVER_IP ?? null;
}

export async function resolveServerHost(
  organizationId: string,
  serverId?: string,
): Promise<string | null> {
  return resolveSnapshotServerHost(
    organizationId,
    serverId ? { serverId } : null,
  );
}

export async function resolveProjectServerHost(project?: Project): Promise<string | null> {
  if (!project) return env.SERVER_IP ?? null;

  const deployment = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId)
    : await repos.deployment.findLatestByProject(project.id);

  const snapshot = (deployment?.meta ?? null) as DeploymentSnapshotLike | null;
  return resolveSnapshotServerHost(project.organizationId, snapshot);
}

/**
 * A bare IPv4/IPv6 address, as opposed to a name that needs resolving. Lives here
 * (the lower-level module) because `edge-target` imports from this file, so the
 * shared predicate can't live there without a cycle.
 *
 * Accepts a bracketed IPv6 literal because `new URL(...).hostname` returns one —
 * the caller below reads exactly that, and an unbracketed-only check answered
 * "not an IP" for every IPv6 public URL.
 */
export function isIpLiteral(value: string): boolean {
  let s = value.trim();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return true;
  const bracketed = s.match(/^\[([^\]]*)\]$/);
  if (bracketed) s = bracketed[1]!;
  return s.includes(":") && /^[0-9a-f:]+$/i.test(s);
}

/**
 * A loopback / unroutable host is useless as public DNS guidance (an A record
 * pointing at 127.0.0.1 is dead). The local "This Server" row's display `sshHost`
 * falls back to `127.0.0.1` when no public IP was known at registration (desktop,
 * or detection skipped) — callers surfacing a "point your domain here" target
 * must treat that as "unknown", not a real address.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h === "0.0.0.0" || h.startsWith("127.");
}

/**
 * Public IP echo endpoints, most white-label first. These return a BARE IP with
 * no branding page (unlike a product like ipify), and we try them in order for
 * redundancy. When Openship Cloud gains its own `/ip` echo we should prepend it.
 */
const IP_ECHO_PROVIDERS = [
  "https://checkip.amazonaws.com",
  "https://icanhazip.com",
  "https://api.ipify.org",
];

async function detectPublicIp(): Promise<string | null> {
  for (const url of IP_ECHO_PROVIDERS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      /* try the next provider */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Detect THIS box's public IP — called ONCE, at "ensure this server" registration
 * (startup/self-server.ts), and stored on the isLocal "This Server" row. Priority:
 * explicit SERVER_IP → an IP literal in OPENSHIP_PUBLIC_URL → a white-label echo
 * probe (self-hosted server boxes only; skipped under CLOUD_MODE and on desktop,
 * where the "public IP" would be a laptop's WAN address). Never throws.
 *
 * NOT for request paths — read the stored value via {@link resolveLocalServerHost}.
 */
export async function resolveInstancePublicIp(): Promise<string | null> {
  if (env.SERVER_IP) return env.SERVER_IP;
  if (env.OPENSHIP_PUBLIC_URL) {
    try {
      const host = new URL(env.OPENSHIP_PUBLIC_URL).hostname;
      if (isIpLiteral(host)) return host;
    } catch {
      /* not a parseable URL — ignore */
    }
  }
  if (env.CLOUD_MODE || env.DEPLOY_MODE === "desktop") return null;
  return detectPublicIp();
}

/**
 * The stored host of an org's "This Server" (isLocal) row — the public address
 * resolved ONCE at ensure-server. A pure read (no detection), so it's safe to
 * call from request paths like the DNS-records preview. SERVER_IP wins when set.
 */
export async function resolveLocalServerHost(organizationId: string): Promise<string | null> {
  if (env.SERVER_IP) return env.SERVER_IP;
  const local = await repos.server.findLocal(organizationId);
  const host = local?.sshHost ?? null;
  // The display host is `127.0.0.1` when no public IP was known at registration;
  // never hand that back as a real target (callers re-detect / show a placeholder).
  return host && !isLoopbackHost(host) ? host : null;
}
