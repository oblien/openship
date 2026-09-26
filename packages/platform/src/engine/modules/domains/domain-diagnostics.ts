import cronParser from "cron-parser";
import { domainRetryEligibleAt, SYSTEM } from "@repo/core";
import type { DomainDiagnostics } from "@repo/contracts";
import { repos, type Domain, type Project, type Service } from "@repo/db";
import { nativeJobsEnabled } from "../../native/execution-policy";
import { tlsIssuedElsewhere } from "../../lib/domain-ssl";

export interface DomainRetrySchedule {
  cron: string | null;
  unavailable: boolean;
}

/** Read the actual operator-controlled job, never invent a retry interval. A
 * missing/unreadable schedule is reported as unknown instead of a promise. */
async function readRetrySchedule(): Promise<DomainRetrySchedule> {
  if (!nativeJobsEnabled()) return { cron: null, unavailable: false };
  try {
    const job = await repos.job.findByKey("domains:verify-pending");
    if (!job) return { cron: null, unavailable: true };
    return {
      cron: job.enabled && job.scheduleType === "recurring" ? job.cronExpression : null,
      unavailable: false,
    };
  } catch {
    return { cron: null, unavailable: true };
  }
}

export function domainDiagnostics(
  domain: Domain,
  project: Pick<Project, "activeDeploymentId" | "deletedAt" | "deletionInProgress" | "disabledAt">,
  schedule: DomainRetrySchedule,
  serviceEnabled = true,
  now = new Date(),
): DomainDiagnostics | null {
  const failed =
    domain.verifyAttempts > 0 ||
    !!domain.lastVerifyError ||
    (!domain.verified && domain.status === "failed") ||
    domain.sslStatus === "error" ||
    domain.sslStatus === "expired";
  const sslExpired =
    !!domain.sslExpiresAt && new Date(domain.sslExpiresAt).getTime() <= now.getTime();

  const waiting = (
    reason: DomainDiagnostics["reason"],
    retryAction: DomainDiagnostics["retryAction"] = null,
  ): DomainDiagnostics => ({
    state: "waiting",
    reason,
    retryAction,
    nextRetryAt: null,
    automaticRetry: "not_applicable",
  });
  if (domain.status === "removing" || project.deletedAt || project.deletionInProgress)
    return waiting("removing");
  if (project.disabledAt || !serviceEnabled) return waiting("disabled");
  if (!project.activeDeploymentId) return waiting("deployment");
  if (domain.sslDnsMode === "manual" && !tlsIssuedElsewhere(domain) && (
    !domain.verified || failed || domain.sslStatus !== "active" || !domain.sslExpiresAt ||
    new Date(domain.sslExpiresAt).getTime() <= now.getTime() + SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS * 86_400_000
  )) {
    return { ...waiting("manual_dns", "verify"), state: failed || sslExpired ? "failed" : "waiting" };
  }
  if (
    domain.verified &&
    !failed &&
    !sslExpired &&
    (domain.sslStatus === "active" ||
      domain.sslStatus === "external" ||
      domain.domainType === "free")
  )
    return null;
  if (domain.domainType === "free" || (domain.verified && tlsIssuedElsewhere(domain))) {
    const details = waiting(
      domain.manualSsl ? "manual_certificate" : "managed_certificate",
      domain.manualSsl ? "verify_ssl" : null,
    );
    return { ...details, state: failed || sslExpired ? "failed" : "waiting" };
  }

  let nextRetryAt: string | null = null;
  let automaticRetry: DomainDiagnostics["automaticRetry"] = schedule.unavailable
    ? "unavailable"
    : "disabled";
  // A healthy retained certificate is not in the pending-certificate sweep.
  // Its last failed read is actionable, but must not promise that sweep will run it.
  const automatic = !domain.verified || domain.sslStatus !== "active" || sslExpired;
  if (automatic && schedule.cron) {
    try {
      const eligible = domainRetryEligibleAt(domain, domain.verified ? 0 : undefined);
      const currentDate = new Date(Math.max(now.getTime(), eligible.getTime() - 1));
      nextRetryAt = cronParser.parseExpression(schedule.cron, { currentDate }).next().toISOString();
      automaticRetry = "scheduled";
    } catch {
      automaticRetry = "unavailable";
    }
  } else if (!automatic) automaticRetry = "not_applicable";
  return {
    state: failed || sslExpired ? "failed" : nextRetryAt ? "pending" : "waiting",
    reason: domain.verified ? "certificate" : "verification",
    retryAction: "verify",
    nextRetryAt,
    automaticRetry,
  };
}

/** Shared by domain list/get and project inspection (the dashboard's read path). */
export async function withDomainDiagnostics(
  project: Project,
  domains: Domain[],
  services?: Pick<Service, "id" | "enabled" | "exposed">[],
) {
  if (domains.length === 0) return [];
  const schedule = await readRetrySchedule();
  const serviceRows =
    services ??
    (domains.some((row) => row.serviceId) ? await repos.service.listByProject(project.id) : []);
  return domains.map((domain) => {
    const diagnostics = domainDiagnostics(
      domain,
      project,
      schedule,
      !domain.serviceId ||
        serviceRows.some((row) => row.id === domain.serviceId && row.enabled && row.exposed),
    );
    return {
      ...domain,
      // Older releases left completed failures labelled pending. Every reader
      // gets the corrected state immediately, without waiting for another try.
      status: !domain.verified && diagnostics?.state === "failed" ? "failed" : domain.status,
      diagnostics,
    };
  });
}
