import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import cronParser from "cron-parser";
import { domainRetryEligibleAt, SYSTEM } from "@repo/core";
import type { DomainDiagnostics } from "@repo/contracts";
import { repos, type Domain, type Project, type Service } from "@repo/db";
import { nativeJobsEnabled } from "../../native/execution-policy";
import { tlsIssuedElsewhere } from "../../lib/domain-ssl";

export interface DomainRetrySchedule {
  cron: string | null;
  unavailable: boolean;
  /** Periodic observation also revisits active certificates after a failed read. */
  healthCheckIntervalMs?: number;
}

/** Read the actual operator-controlled job, never invent a retry interval. A
 * missing/unreadable schedule is reported as unknown instead of a promise. */
async function readRetrySchedule(jobKey = "domains:verify-pending"): Promise<DomainRetrySchedule> {
  if (!nativeJobsEnabled()) return { cron: null, unavailable: false };
  try {
    const job = await repos.job.findByKey(jobKey);
    if (!job) return { cron: null, unavailable: true };
    return {
      cron: job.enabled && job.scheduleType === "recurring" ? job.cronExpression : null,
      unavailable: false,
    };
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/domains/domain-diagnostics");
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
  // Cloud's observer revisits active TLS; the issuance sweep only takes pending
  // certificates. Report the job that actually owns this domain's next check.
  const automatic = !!schedule.healthCheckIntervalMs || !domain.verified || domain.sslStatus !== "active" || sslExpired;
  if (automatic && schedule.cron) {
    try {
      const eligible = domainRetryEligibleAt(domain, domain.verified ? 0 : undefined);
      const observedAfter = schedule.healthCheckIntervalMs && domain.lastCheckedAt
        ? new Date(domain.lastCheckedAt).getTime() + schedule.healthCheckIntervalMs : 0;
      const currentDate = new Date(Math.max(now.getTime(), eligible.getTime() - 1, observedAfter - 1));
      nextRetryAt = cronParser.parseExpression(schedule.cron, { currentDate }).next().toISOString();
      automaticRetry = "scheduled";
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/domains/domain-diagnostics");
      automaticRetry = "unavailable";
    }
  } else if (!automatic) automaticRetry = "not_applicable";
  return {
    state: failed || sslExpired ? "failed" : nextRetryAt ? "pending" : "waiting",
    reason: domain.verified ? "certificate" : "verification",
    retryAction: schedule.healthCheckIntervalMs ? "verify_ssl" : "verify",
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
  const cloudHealthCheck = (domain: Domain) => !!project.workspaceId && domain.verified &&
    domain.domainType === "custom" && !domain.manualSsl && !domain.externalIngress && !domain.hostname.includes("*");
  const [schedule, cloudSchedule] = await Promise.all([
    readRetrySchedule(),
    domains.some(cloudHealthCheck) ? readRetrySchedule("domains:check-https") : null,
  ]);
  const serviceRows =
    services ??
    (domains.some((row) => row.serviceId) ? await repos.service.listByProject(project.id) : []);
  return domains.map((domain) => {
    const serviceEnabled = !domain.serviceId ||
      serviceRows.some((row) => row.id === domain.serviceId && row.enabled && row.exposed);
    let diagnostics = domainDiagnostics(domain, project, schedule, serviceEnabled);
    if (cloudSchedule && cloudHealthCheck(domain)) {
      const observation = domainDiagnostics(domain, project, {
        ...cloudSchedule, healthCheckIntervalMs: SYSTEM.DOMAINS.SSL_HEALTH_CHECK_INTERVAL_MS,
      }, serviceEnabled);
      // Pending TLS may also be checked by the existing issuance sweep. Show
      // the earliest enabled check, including when either job is disabled.
      const candidates = [diagnostics, observation].filter((entry) => entry !== null);
      diagnostics = candidates.filter((entry) => entry.nextRetryAt)
        .sort((a, b) => Date.parse(a.nextRetryAt!) - Date.parse(b.nextRetryAt!))[0]
        ?? candidates.find((entry) => entry.automaticRetry === "unavailable")
        ?? observation ?? diagnostics;
    }
    return {
      ...domain,
      // Older releases left completed failures labelled pending. Every reader
      // gets the corrected state immediately, without waiting for another try.
      status: !domain.verified && diagnostics?.state === "failed" ? "failed" : domain.status,
      diagnostics,
    };
  });
}
