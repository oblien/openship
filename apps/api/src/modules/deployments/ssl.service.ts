/**
 * SSL service - certificate status checks and renewal via platform adapters.
 */

import { repos } from "@repo/db";
import { NotFoundError } from "@repo/core";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { manageDomainSsl } from "../../lib/domain-ssl";

/**
 * Check SSL status for a domain.
 * Returns the DB record + live cert info from the adapter.
 */
export async function getStatus(hostname: string, organizationId: string) {
  const domainRecord = await repos.domain.findByHostname(hostname);
  if (!domainRecord) throw new NotFoundError("Domain", hostname);

  // Verify ownership through project's organization
  const project = await repos.project.findById(domainRecord.projectId);
  assertResourceInOrg(project, "Project", organizationId, domainRecord.projectId ?? undefined);

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
 *
 * Org-scoped: resolves the domain to its project and refuses if the
 * project doesn't belong to the caller's org. Without this any user
 * with deployment:write in any org could trigger ACME renewal on any
 * domain — burns the shared Let's Encrypt rate-limit pool and writes
 * across tenants.
 */
export async function renew(
  hostname: string,
  organizationId: string,
  includeWww = false,
) {
  const domainRecord = await repos.domain.findByHostname(hostname);
  if (!domainRecord) throw new NotFoundError("Domain", hostname);

  const project = await repos.project.findById(domainRecord.projectId);
  assertResourceInOrg(project, "Project", organizationId, domainRecord.projectId ?? undefined);

  const result = await manageDomainSsl(hostname, {
    action: "renew",
    includeWww,
  });

  // Honest status: a cert was actually issued ONLY if we got an expiry back.
  // certbot failures throw (caught by the controller, which surfaces the real
  // ACME error), so reaching here with no expiresAt means a no-op provider or
  // an unreadable cert — report it as still-provisioning, NOT "renewed", so the
  // UI doesn't show a green toast over a domain that's still on HTTP.
  const issued = Boolean(result.expiresAt);
  return {
    success: issued,
    domain: hostname,
    status: issued ? "active" : "provisioning",
    expiresAt: result.expiresAt,
    issuer: result.issuer,
    ...(issued
      ? {}
      : {
          message:
            `No certificate was issued for ${hostname} yet. Confirm its DNS points to this server and the domain is reachable over HTTP (port 80), then try again.`,
        }),
  };
}

