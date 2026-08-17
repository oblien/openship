/**
 * Persist imported / restored edge hostnames as domain rows so ssl:renew
 * (findExpiringSsl) can see them. registerImportedSites only writes vhosts.
 */
import type { ImportedSiteRegistration } from "@repo/adapters";
import { repos } from "@repo/db";
import { env } from "../config/env";
import { isControlPlaneProject } from "./controller-helpers";

export function hostnameFromPublicUrl(raw: string | undefined | null): string | null {
  if (!raw?.trim()) return null;
  try {
    return new URL(raw.trim()).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export async function reservedOperatorDomains(): Promise<string[]> {
  const out = new Set<string>();
  const fromEnv = hostnameFromPublicUrl(env.OPENSHIP_PUBLIC_URL);
  if (fromEnv) out.add(fromEnv);

  const projects = await repos.project.listAllForScan().catch(() => []);
  for (const project of projects) {
    if (!isControlPlaneProject(project)) continue;
    const rows = await repos.domain.listByProject(project.id).catch(() => []);
    for (const row of rows) out.add(row.hostname.toLowerCase());
  }
  return [...out];
}

export async function trackImportedDomain(info: ImportedSiteRegistration): Promise<void> {
  const hostname = info.domain.trim().toLowerCase();
  if (!hostname) return;

  const existing = await repos.domain.findByHostname(hostname);
  const expiresAt = info.cert?.expiresAt ? new Date(info.cert.expiresAt) : undefined;
  const sslActive = Boolean(info.ssl && info.cert?.verified && expiresAt && !Number.isNaN(expiresAt.getTime()));

  if (existing) {
    if (sslActive) {
      await repos.domain.updateSsl(existing.id, {
        sslStatus: "active",
        sslIssuer: info.cert?.issuer || existing.sslIssuer || undefined,
        sslExpiresAt: expiresAt,
      });
    }
    return;
  }

  const created = await repos.domain.findOrCreate({
    hostname,
    ownerType: "project",
    projectId: null,
    domainType: "custom",
    status: "active",
    verified: true,
    verifiedAt: new Date(),
    sslStatus: sslActive ? "active" : info.ssl ? "provisioning" : "none",
    sslIssuer: info.cert?.issuer || undefined,
    sslExpiresAt: sslActive ? expiresAt : undefined,
  });

  if (sslActive && created.sslStatus !== "active") {
    await repos.domain.updateSsl(created.id, {
      sslStatus: "active",
      sslIssuer: info.cert?.issuer || undefined,
      sslExpiresAt: expiresAt,
    });
  }
}
