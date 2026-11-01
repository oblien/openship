import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { CommandExecutor } from "@repo/adapters";
import { repos } from "@repo/db";
import {
  NotFoundError,
  SYSTEM,
  currentMailCertificateHealth,
  mailHostname,
  safeErrorMessage,
  type MailCertificateHealth,
  type MailCertificateStatus,
} from "@repo/core";
import { env } from "../../config/env";
import { nativeJobsEnabled } from "../../native/execution-policy";
import { createProvisionLock } from "../../lib/provision-lock";
import { sshManager } from "../../lib/ssh-manager";
import {
  checkMailCertificate,
  configureMailCertificate,
  retireLegacyMailRenewal,
} from "./mail-certificate-probe";

const CACHE_MS = 5 * 60_000;
const checks = new Map<string, Promise<MailCertificateHealth | null>>();
const lockKey = (serverId: string) => `mail:certificate:${serverId}`;
type MailServer = NonNullable<Awaited<ReturnType<typeof repos.mailServer.get>>>;

async function requireMailServer(serverId: string): Promise<MailServer> {
  if (env.CLOUD_MODE) throw new NotFoundError("Mail server", serverId);
  const mail = await repos.mailServer.get(serverId);
  if (!mail) throw new NotFoundError("Mail server", serverId);
  return mail;
}

/** One cached/coalesced probe serves Health, Advanced and the existing infra scan.
 * The issue feed only reads the persisted observation, never calls this function. */
export async function refreshMailCertificate(
  serverId: string,
  options: { executor?: CommandExecutor; force?: boolean } = {},
): Promise<MailCertificateHealth | null> {
  if (env.CLOUD_MODE) return null;
  const running = checks.get(serverId);
  if (running) return running;
  const pending = (async () => {
    const mail = await repos.mailServer.get(serverId);
    if (!mail) return null;
    const cached = mail.certificateHealth;
    if (
      !options.force &&
      cached?.hostname === mailHostname(mail.domain) &&
      Date.now() - new Date(cached.checkedAt).getTime() < CACHE_MS
    ) {
      return currentMailCertificateHealth(cached, SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS);
    }
    const probe = (executor: CommandExecutor) =>
      checkMailCertificate(executor, mailHostname(mail.domain));
    let health: MailCertificateHealth;
    try {
      health = options.executor
        ? await probe(options.executor)
        : await sshManager.withExecutor(serverId, probe);
    } catch (error) {
      observeCaughtError(error, "platform/engine/modules/mail/mail-certificate.service");
      health = {
        hostname: mailHostname(mail.domain),
        checkedAt: new Date().toISOString(),
        status: "unknown",
        reason: "unavailable",
        detail: safeErrorMessage(error).slice(0, 500),
        certificate: null,
        endpoints: [],
      };
    }
    await repos.mailServer.setCertificateHealth(serverId, health);
    return health;
  })();
  checks.set(serverId, pending);
  try {
    return await pending;
  } finally {
    if (checks.get(serverId) === pending) checks.delete(serverId);
  }
}

export async function getMailCertificateStatus(
  serverId: string,
  refresh = false,
): Promise<MailCertificateStatus> {
  const mail = await requireMailServer(serverId);
  const [health, job] = await Promise.all([
    refreshMailCertificate(serverId, { force: refresh }),
    repos.job.findByKey("ssl:renew"),
  ]);
  return {
    serverId,
    hostname: mailHostname(mail.domain),
    autoRenew: mail.certificateAutoRenew,
    renewalJobEnabled:
      nativeJobsEnabled() &&
      !!job?.enabled &&
      !!job.cronExpression &&
      job.scheduleType === "recurring",
    desktop: env.DEPLOY_MODE === "desktop",
    lastRenewalError: mail.certificateRenewalError,
    health,
  };
}

export async function setMailCertificateAutoRenew(
  serverId: string,
  enabled: boolean,
): Promise<MailCertificateStatus> {
  await createProvisionLock(lockKey(serverId)).run(async () => {
    const mail = await requireMailServer(serverId);
    // The switch must control the actual renewal owner, including adopted host installs.
    // Refuse a shared legacy timer rather than disable another certificate's renewals.
    await sshManager.withExecutor(serverId, (executor) =>
      retireLegacyMailRenewal(executor, mailHostname(mail.domain)),
    );
    await repos.mailServer.setCertificateAutoRenew(serverId, enabled);
  });
  return getMailCertificateStatus(serverId);
}

/** Called by the shared SSL lifecycle after mail issuance (also on recovered issuance).
 * A readable file is not success until Postfix and Dovecot serve it. */
export async function applyMailCertificate(serverId: string, hostname: string): Promise<void> {
  const mail = await requireMailServer(serverId);
  if (mailHostname(mail.domain) !== hostname) throw new NotFoundError("Mail certificate", hostname);
  try {
    await sshManager.withExecutor(serverId, async (executor) => {
      await configureMailCertificate(executor, hostname);
      // A pre-renewal Health request must finish before the post-reload observation.
      await checks.get(serverId)?.catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/mail/mail-certificate.service"); return undefined; });
      const health = await refreshMailCertificate(serverId, { executor, force: true });
      if (!health || (health.status !== "ok" && health.status !== "warn")) {
        throw new Error(
          health?.detail ?? "Could not confirm the renewed mail certificate on SMTP and IMAP.",
        );
      }
    });
    await repos.mailServer.setCertificateRenewalError(serverId, null);
  } catch (error) {
    await repos.mailServer
      .setCertificateRenewalError(serverId, safeErrorMessage(error))
      .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/mail/mail-certificate.service"); return undefined; });
    throw error;
  }
}

/** Both manual and scheduled renewal enter the shared locked edge/ACME lifecycle.
 * `provision` reads before issuing: a healthy certificate is reused, while a stale
 * daemon is still repaired. Repeated clicks cannot consume fresh ACME orders. */
export async function renewMailCertificate(
  serverId: string,
  automatic = false,
): Promise<MailCertificateStatus | null> {
  const ran = await createProvisionLock(lockKey(serverId)).run(async () => {
    const mail = await requireMailServer(serverId);
    if (automatic && (!mail.installedAt || !mail.certificateAutoRenew)) return false;
    const hostname = mailHostname(mail.domain);
    try {
      const { ensureMailCertDomain, manageDomainSsl, recordMailCertDomain, resolveMailOwner } =
        await import("../../lib/domain-ssl");
      const owner = await resolveMailOwner(hostname);
      if (owner?.serverId !== serverId) throw new NotFoundError("Mail certificate", hostname);
      await ensureMailCertDomain(hostname);
      await sshManager.withExecutor(serverId, (executor) =>
        retireLegacyMailRenewal(executor, hostname),
      );
      const health = await refreshMailCertificate(serverId, { force: true });
      if (health?.certificate && health.reason !== "untrusted") {
        await recordMailCertDomain(hostname, {
          domain: hostname,
          verified: true,
          expiresAt: health.certificate.expiresAt,
          issuer: health.certificate.issuer,
        });
      }
      if (automatic && health?.status === "ok" && !mail.certificateRenewalError) return false;
      // Unknown connectivity is not a reason to open an ACME order.
      if (automatic && health?.status === "unknown")
        throw new Error(health.detail ?? "Mail TLS check is unavailable.");
      const result = await manageDomainSsl(hostname, {
        action: "provision",
        mailServerId: serverId,
      });
      if (!result.verified || !result.expiresAt || new Date(result.expiresAt).getTime() <= Date.now()) throw new Error("Renewal did not produce a valid mail certificate.");
      return true;
    } catch (error) {
      await repos.mailServer
        .setCertificateRenewalError(serverId, safeErrorMessage(error))
        .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/mail/mail-certificate.service"); return undefined; });
      throw error;
    }
  });
  return ran || !automatic ? getMailCertificateStatus(serverId) : null;
}
