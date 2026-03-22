/**
 * SSL service — certificate status checks and renewal via platform adapters.
 */

import { repos } from "@repo/db";
import { NotFoundError } from "@repo/core";
import { manageDomainSsl } from "../../lib/domain-ssl";

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
  const result = await manageDomainSsl(hostname, {
    action: "renew",
    userId,
    includeWww,
  });

  return {
    success: true,
    domain: hostname,
    expiresAt: result.expiresAt,
    issuer: result.issuer,
  };
}
