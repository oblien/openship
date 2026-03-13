/**
 * SSL service — certificate status checks and renewal via platform adapters.
 */

import { repos } from "@repo/db";
import { NotFoundError } from "@repo/core";
import { platform } from "../../lib/controller-helpers";

/**
 * Check SSL status for a domain.
 * Returns the DB record + live cert info from the adapter.
 */
export async function getStatus(hostname: string, userId: string) {
  const domainRecord = await repos.domain.findByHostname(hostname);
  if (!domainRecord) throw new NotFoundError("Domain", hostname);

  // Verify ownership through project
  const project = await repos.project.findById(domainRecord.projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Domain", hostname);
  }

  return {
    domain: domainRecord.hostname,
    sslStatus: domainRecord.sslStatus,
    sslIssuer: domainRecord.sslIssuer,
    sslExpiresAt: domainRecord.sslExpiresAt,
    verified: domainRecord.verified,
  };
}

/**
 * Renew (or provision) an SSL certificate for a domain.
 */
export async function renew(hostname: string, userId: string, includeWww = false) {
  const domainRecord = await repos.domain.findByHostname(hostname);
  if (!domainRecord) throw new NotFoundError("Domain", hostname);

  const project = await repos.project.findById(domainRecord.projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Domain", hostname);
  }

  const { ssl } = platform();
  const result = await ssl.renewCert(hostname);

  await repos.domain.updateSsl(domainRecord.id, {
    sslStatus: "active",
    sslIssuer: result.issuer,
    sslExpiresAt: new Date(result.expiresAt),
  });

  // Optionally renew www subdomain
  if (includeWww) {
    const wwwHostname = `www.${hostname}`;
    const wwwRecord = await repos.domain.findByHostname(wwwHostname);
    if (wwwRecord) {
      const wwwResult = await ssl.renewCert(wwwHostname);
      await repos.domain.updateSsl(wwwRecord.id, {
        sslStatus: "active",
        sslIssuer: wwwResult.issuer,
        sslExpiresAt: new Date(wwwResult.expiresAt),
      });
    }
  }

  return {
    success: true,
    domain: hostname,
    expiresAt: result.expiresAt,
    issuer: result.issuer,
  };
}
