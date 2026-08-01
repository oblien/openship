/**
 * SSL service - certificate status checks and renewal via platform adapters.
 */

import { repos } from "@repo/db";
import { NotFoundError, safeErrorMessage, wwwSiblingHostname } from "@repo/core";
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

export interface SslRenewOutcome {
  success: boolean;
  domain: string;
  status: string;
  expiresAt?: string;
  issuer?: string;
  message?: string;
}

/**
 * Renew (or provision) the certificate for ONE hostname.
 *
 * Org-scoped: resolves the domain to its project and refuses if the
 * project doesn't belong to the caller's org. Without this any user
 * with deployment:write in any org could trigger ACME renewal on any
 * domain — burns the shared Let's Encrypt rate-limit pool and writes
 * across tenants.
 */
async function renewOne(hostname: string, organizationId: string): Promise<SslRenewOutcome> {
  const domainRecord = await repos.domain.findByHostname(hostname);
  if (!domainRecord) throw new NotFoundError("Domain", hostname);

  const project = await repos.project.findById(domainRecord.projectId);
  assertResourceInOrg(project, "Project", organizationId, domainRecord.projectId ?? undefined);

  const result = await manageDomainSsl(hostname, { action: "renew" });

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

/**
 * Renew `hostname`, plus its `www.` sibling when `includeWww` is set.
 *
 * The two are renewed INDEPENDENTLY and both outcomes are returned. They used to
 * share one `manageDomainSsl(includeWww)` call, where the sibling ran unguarded
 * after the apex had already succeeded: a www that isn't pointed here yet threw,
 * and the caller reported the APEX as failed. `www.<apex>` is its own domain row
 * with its own DNS record and certificate, so its failure is its own.
 *
 * The top-level fields mirror the requested hostname's outcome (unchanged wire
 * shape for existing callers); `results` carries every host that was touched.
 */
export async function renew(
  hostname: string,
  organizationId: string,
  includeWww = false,
): Promise<SslRenewOutcome & { results: SslRenewOutcome[] }> {
  // The requested host is what the caller asked for — let its failure throw, so
  // the controller still surfaces the real ACME error for it.
  const primary = await renewOne(hostname, organizationId);
  const results: SslRenewOutcome[] = [primary];

  const www = includeWww ? wwwSiblingHostname(hostname) : null;
  if (www) {
    // Best-effort, and reported: the sibling may not have a row yet, may not be
    // pointed here, or may be externally-certed. None of that is a reason to
    // fail the renewal the caller actually asked for.
    results.push(
      await renewOne(www, organizationId).catch((err) => ({
        success: false,
        domain: www,
        status: "error",
        message: safeErrorMessage(err),
      })),
    );
  }

  return { ...primary, results };
}

