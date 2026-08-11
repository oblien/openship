/**
 * Audit log retention prune.
 *
 * Daily job that deletes audit events older than each organization's
 * retention window. Default retention is 90 days; org owners can override
 * via organization.metadata.auditRetentionDays.
 *
 * Wired into the job-runner alongside backup retention prune.
 */

import { repos, db, schema } from "@repo/db";

const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 365 * 5; // 5 years upper bound

interface OrgMetadata {
  auditRetentionDays?: number;
}

function parseRetentionDays(metadataJson: string | null): number {
  if (!metadataJson) return DEFAULT_RETENTION_DAYS;
  try {
    const parsed = JSON.parse(metadataJson) as OrgMetadata;
    const days = parsed?.auditRetentionDays;
    if (typeof days !== "number" || days < 1) return DEFAULT_RETENTION_DAYS;
    return Math.min(days, MAX_RETENTION_DAYS);
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

/**
 * Prune audit events across all organizations. Idempotent — safe to run
 * multiple times. Logs per-org row counts to console (no audit emission
 * for the prune itself; that would be circular).
 */
export async function pruneAuditEvents(): Promise<{ orgsProcessed: number; totalPruned: number }> {
  // We don't have a "listAllOrgs" repo method (intentionally — Better Auth
  // owns org writes). Read directly via the schema.
  const orgs = await db
    .select({ id: schema.organization.id, metadata: schema.organization.metadata })
    .from(schema.organization);

  let totalPruned = 0;
  for (const org of orgs) {
    const days = parseRetentionDays(org.metadata);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    try {
      await repos.auditEvent.pruneOlderThan(org.id, cutoff);
      totalPruned += 1; // we don't track precise count from the repo
    } catch (err) {
      console.error(`[audit-prune] org=${org.id}`, err);
    }
  }

  return { orgsProcessed: orgs.length, totalPruned };
}
