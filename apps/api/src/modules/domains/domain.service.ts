/**
 * Domain service — manage custom domains, DNS verification, SSL certificates.
 *
 * Flow:
 *   1. User adds a domain → status: pending, verification token generated
 *   2. User adds DNS TXT record
 *   3. User triggers verify → DNS lookup checks TXT record
 *   4. On verification → provision SSL via adapter
 *   5. Register reverse-proxy route via adapter
 */

import { repos, type Domain } from "@repo/db";
import { NotFoundError, ConflictError, ForbiddenError } from "@repo/core";
import { platform } from "../../lib/controller-helpers";
import type { TAddDomainBody } from "./domain.schema";

// ─── List domains ────────────────────────────────────────────────────────────

export async function listDomains(projectId: string, userId: string) {
  // Verify ownership
  const project = await repos.project.findById(projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Project", projectId);
  }

  return repos.domain.listByProject(projectId);
}

// ─── Add domain ──────────────────────────────────────────────────────────────

export async function addDomain(userId: string, data: TAddDomainBody) {
  // Verify project ownership
  const project = await repos.project.findById(data.projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Project", data.projectId);
  }

  // Check for duplicate hostname
  const existing = await repos.domain.findByHostname(data.hostname);
  if (existing) {
    throw new ConflictError(`Domain "${data.hostname}" is already in use`);
  }

  const domain = await repos.domain.create({
    projectId: data.projectId,
    hostname: data.hostname,
    isPrimary: data.isPrimary ?? false,
  });

  // If primary, update project
  if (data.isPrimary) {
    await repos.domain.setPrimary(data.projectId, domain.id);
  }

  return domain;
}

// ─── Verify domain ──────────────────────────────────────────────────────────

export async function verifyDomain(domainId: string, userId: string) {
  const domain = await getDomainWithAuth(domainId, userId);

  if (domain.verified) {
    return { verified: true, message: "Domain is already verified" };
  }

  // DNS TXT record lookup
  const verified = await checkDnsVerification(domain.hostname, domain.verificationToken!);

  if (verified) {
    await repos.domain.markVerified(domainId);

    // Provision SSL and register route
    try {
      const { runtime, routing, ssl } = platform();
      const sslResult = await ssl.provisionCert(domain.hostname);
      await repos.domain.updateSsl(domainId, {
        sslStatus: "active",
        sslIssuer: sslResult.issuer,
        sslExpiresAt: sslResult.expiresAt ? new Date(sslResult.expiresAt) : undefined,
      });

      // Register reverse-proxy route
      const project = await repos.project.findById(domain.projectId);
      if (project?.activeDeploymentId) {
        const dep = await repos.deployment.findById(project.activeDeploymentId);
        if (dep?.containerId) {
          const ip = await runtime.getContainerIp(dep.containerId);
          if (ip) {
            await routing.registerRoute({
              domain: domain.hostname,
              targetUrl: `http://${ip}:${project.port ?? 3000}`,
              tls: true,
            });
          }
        }
      }
    } catch (err) {
      console.error(`[DOMAIN] SSL provisioning failed for ${domain.hostname}:`, err);
      await repos.domain.updateSsl(domainId, { sslStatus: "error" });
    }

    return { verified: true, message: "Domain verified successfully" };
  }

  return {
    verified: false,
    message: `DNS verification pending. Add a TXT record for _openship-challenge.${domain.hostname} with value: ${domain.verificationToken}`,
  };
}

// ─── Remove domain ──────────────────────────────────────────────────────────

export async function removeDomain(domainId: string, userId: string) {
  const domain = await getDomainWithAuth(domainId, userId);

  // Remove reverse-proxy route
  try {
    const { routing } = platform();
    await routing.removeRoute(domain.hostname);
  } catch (err) {
    console.error(`[DOMAIN] Failed to remove route for ${domain.hostname}:`, err);
  }

  await repos.domain.remove(domainId);
}
// ─── SSL renewal ─────────────────────────────────────────────────────────

/**
 * Renew SSL for a single domain (user-initiated).
 */
export async function renewDomainSsl(domainId: string, userId: string) {
  const domain = await getDomainWithAuth(domainId, userId);

  if (!domain.verified) {
    throw new ForbiddenError("Domain must be verified before SSL can be renewed");
  }

  const { ssl } = platform();
  const result = await ssl.renewCert(domain.hostname);

  await repos.domain.updateSsl(domainId, {
    sslStatus: "active",
    sslExpiresAt: new Date(result.expiresAt),
    sslIssuer: result.issuer,
  });

  return {
    domain: domain.hostname,
    sslStatus: "active",
    expiresAt: result.expiresAt,
    issuer: result.issuer,
  };
}

/**
 * Batch-renew all expiring SSL certificates.
 * Meant to be called from an admin endpoint or external cron.
 */
export { renewExpiringCerts } from "../../lib/ssl-scheduler";
// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getDomainWithAuth(domainId: string, userId: string): Promise<Domain> {
  const domain = await repos.domain.findById(domainId);
  if (!domain) throw new NotFoundError("Domain", domainId);

  const project = await repos.project.findById(domain.projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Domain", domainId);
  }

  return domain;
}

/**
 * Check if a DNS TXT record matches the expected verification token.
 * Uses Node's built-in dns module.
 */
async function checkDnsVerification(hostname: string, expectedToken: string): Promise<boolean> {
  try {
    const dns = await import("node:dns/promises");
    const records = await dns.resolveTxt(`_openship-challenge.${hostname}`);
    const values = records.flat();
    return values.some((v) => v === expectedToken);
  } catch {
    return false;
  }
}
