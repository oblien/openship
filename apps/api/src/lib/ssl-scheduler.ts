/**
 * SSL renewal — on-demand batch renewal of expiring certificates.
 *
 * Not a background scheduler. Call `renewExpiringCerts()` from:
 *   - An admin / internal API endpoint (e.g. POST /api/domains/renew)
 *   - An external cron job (Kubernetes CronJob, systemd timer, etc.)
 *
 * In most setups renewal is handled by the infrastructure layer itself:
 *   - Docker: Traefik / Caddy auto-renew Let's Encrypt certs
 *   - Cloud:  Provider manages TLS termination
 *
 * This function exists as a fallback for setups where we provision certs
 * ourselves via the adapter's `provisionCert` / `renewCert` methods.
 */

import { repos } from "@repo/db";
import { SYSTEM } from "@repo/core";
import { platform } from "./controller-helpers";
import { notify } from "./notifications";

// ─── Core renewal logic ──────────────────────────────────────────────────────

export interface RenewalResult {
  renewed: number;
  failed: number;
  total: number;
  details: Array<{ domain: string; status: "renewed" | "failed"; error?: string }>;
}

/**
 * Renew all SSL certificates expiring within `SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS`.
 *
 * - Batched to `SYSTEM.DOMAINS.SSL_RENEW_BATCH_SIZE` per call
 * - De-duplicates project → user lookups
 * - Sends notifications on success / failure
 * - Returns a structured result for the caller to log or return to the client
 */
export async function renewExpiringCerts(): Promise<RenewalResult> {
  const { ssl } = platform();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS);

  const allDomains = await repos.domain.findExpiringSsl(cutoff);

  if (allDomains.length === 0) {
    return { renewed: 0, failed: 0, total: 0, details: [] };
  }

  const batch = allDomains.slice(0, SYSTEM.DOMAINS.SSL_RENEW_BATCH_SIZE);

  // Pre-fetch project → user map (avoids N+1)
  const projectIds = [...new Set(batch.map((d) => d.projectId))];
  const ownerCache = new Map<string, { email?: string; projectName: string }>();

  for (const pid of projectIds) {
    const project = await repos.project.findById(pid);
    if (!project) continue;
    const user = await repos.user.findById(project.userId);
    ownerCache.set(pid, { email: user?.email, projectName: project.name });
  }

  const details: RenewalResult["details"] = [];
  let renewed = 0;
  let failed = 0;

  for (const domain of batch) {
    const owner = ownerCache.get(domain.projectId);

    try {
      const result = await ssl.renewCert(domain.hostname);

      await repos.domain.updateSsl(domain.id, {
        sslStatus: "active",
        sslExpiresAt: new Date(result.expiresAt),
        sslIssuer: result.issuer,
      });

      renewed++;
      details.push({ domain: domain.hostname, status: "renewed" });

      if (owner?.email) {
        void notify("ssl_renewed", {
          email: owner.email,
          projectName: owner.projectName,
          data: { domain: domain.hostname, expiresAt: result.expiresAt },
        });
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      details.push({ domain: domain.hostname, status: "failed", error: message });

      await repos.domain.updateSsl(domain.id, { sslStatus: "error" }).catch(() => {});

      if (owner?.email) {
        const daysLeft = Math.ceil(
          ((domain.sslExpiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000,
        );
        void notify("ssl_expiring", {
          email: owner.email,
          projectName: owner.projectName,
          data: { domain: domain.hostname, daysLeft },
        });
      }
    }
  }

  return { renewed, failed, total: allDomains.length, details };
}
