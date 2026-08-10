/**
 * SSL renewal — batch renewal of expiring certbot certificates.
 *
 * Wired to the shared JobRunner as the "ssl:renew" system job on self-hosted
 * installs (registered via the generic jobs module — see
 * modules/jobs/job.registry.ts). Still callable directly from an admin endpoint
 * or external cron.
 *
 * Each expiring domain is renewed via `manageDomainSsl`, which resolves the SSL
 * provider on the SAME host that serves the domain (per-project, not the global
 * orchestrator) — so multi-server self-hosted renews on the right box. Manual
 * (BYO) certs are skipped: certbot never issued them, so they can't be renewed.
 */

import { repos } from "@repo/db";
import { SYSTEM } from "@repo/core";
import {
  MAIL_DOMAIN_OWNER,
  manageDomainSsl,
  resolveMailOwner,
  tlsIssuedElsewhere,
} from "./domain-ssl";
import { notification } from "./notification-dispatcher";

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
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS);

  // Domains whose TLS isn't ours to re-issue: an uploaded cert (BYO / Cloudflare
  // Origin CA) certbot never issued, an upstream ingress ACME can't reach, or a
  // managed *.opsh.io host Cloud terminates. `manageDomainSsl` refuses all three
  // anyway — filtering here keeps them out of the batch and out of the "renewed"
  // count, which is what "0 of N renewed" should mean.
  //
  // Previously only `manualSsl` was excluded. The other two escaped by luck: their
  // rows carry no `sslExpiresAt`, and findExpiringSsl compares on it — so a single
  // `updateSsl({ sslExpiresAt })` anywhere would have handed them to certbot.
  const allDomains = (await repos.domain.findExpiringSsl(cutoff)).filter(
    (d) => !tlsIssuedElsewhere(d),
  );

  if (allDomains.length === 0) {
    return { renewed: 0, failed: 0, total: 0, details: [] };
  }

  const batch = allDomains.slice(0, SYSTEM.DOMAINS.SSL_RENEW_BATCH_SIZE);

  // Pre-fetch project → (org, project name) so the dispatcher knows
  // which org to fan out the notification to. Each org's members each
  // receive notifications via their configured channels.
  const projectIds = [...new Set(batch.map((d) => d.projectId).filter((p): p is string => p !== null))];
  const projectCache = new Map<
    string,
    { organizationId: string; projectName: string }
  >();
  for (const pid of projectIds) {
    const project = await repos.project.findById(pid);
    if (!project) continue;
    projectCache.set(pid, {
      organizationId: project.organizationId,
      projectName: project.name,
    });
  }

  /**
   * The notification context for one row. A project-owned row gets it from the
   * project; a MAIL-owned row has no project, so it resolves the org from the mail
   * server (`resolveMailOwner`). Without this branch `ctx` was undefined for mail
   * and the `if (ctx)` guard below silently dropped the alert — so a mail
   * certificate whose renewal FAILED went to `sslStatus: "error"` and told nobody,
   * which is the same silent-expiry shape this row exists to prevent.
   */
  const notifyContext = async (
    d: (typeof batch)[number],
  ): Promise<{ organizationId: string; projectName: string } | undefined> => {
    if (d.projectId) return projectCache.get(d.projectId);
    if (d.ownerType !== MAIL_DOMAIN_OWNER) return undefined;
    const owner = await resolveMailOwner(d.hostname).catch(() => null);
    return owner
      ? { organizationId: owner.organizationId, projectName: `Mail (${d.hostname})` }
      : undefined;
  };

  const details: RenewalResult["details"] = [];
  let renewed = 0;
  let failed = 0;

  for (const domain of batch) {
    const ctx = await notifyContext(domain);

    try {
      // manageDomainSsl resolves the provider on the serving host and persists
      // the outcome (no-clobber). A non-verified result means no valid cert
      // landed — treat as a failure so it's surfaced, not silently "renewed".
      const result = await manageDomainSsl(domain.hostname, {
        action: "renew",
        projectId: domain.projectId ?? undefined,
      });
      if (!result.verified) {
        throw new Error(
          result.reason === "missing"
            ? "no certificate present after renew"
            : "renew did not produce a valid certificate",
        );
      }

      renewed++;
      details.push({ domain: domain.hostname, status: "renewed" });

      // ssl_renewed isn't a notification category (renewal success is
      // expected — only failures are noteworthy). Skip dispatch.
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      details.push({ domain: domain.hostname, status: "failed", error: message });

      await repos.domain.updateSsl(domain.id, { sslStatus: "error" }).catch(() => {});

      if (ctx) {
        const daysLeft = Math.ceil(
          ((domain.sslExpiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000,
        );
        notification.emit({
          organizationId: ctx.organizationId,
          eventType: "ssl.renewal_failed",
          resourceType: "domain",
          resourceId: domain.id,
          payload: {
            projectName: ctx.projectName,
            domain: domain.hostname,
            daysLeft,
            errorMessage: message,
          },
        });
      }
    }
  }

  return { renewed, failed, total: allDomains.length, details };
}
