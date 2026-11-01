/** Public certificate observations; never contains a private key or mail credentials. */
export interface MailCertificateInfo {
  expiresAt: string;
  issuer: string;
  fingerprint: string;
}

export interface MailCertificateEndpoint {
  protocol: "smtp" | "smtps" | "imap";
  port: number;
  certificate: MailCertificateInfo | null;
  trusted: boolean;
  detail?: string;
}

export interface MailCertificateHealth {
  hostname: string;
  checkedAt: string;
  status: "ok" | "warn" | "fail" | "unknown";
  reason?: "expired" | "expiring" | "missing" | "untrusted" | "not_loaded" | "unavailable";
  detail?: string;
  certificate: MailCertificateInfo | null;
  endpoints: MailCertificateEndpoint[];
}

export interface MailCertificateStatus {
  serverId: string;
  hostname: string;
  autoRenew: boolean;
  renewalJobEnabled: boolean;
  desktop: boolean;
  lastRenewalError: string | null;
  health: MailCertificateHealth | null;
}

/** Expiry keeps advancing even when a cached reading is all the UI can access. */
export function currentMailCertificateHealth(
  health: MailCertificateHealth | null,
  renewBeforeDays: number,
  now = Date.now(),
): MailCertificateHealth | null {
  if (!health) return null;
  const certificates = [health.certificate, ...health.endpoints.map((p) => p.certificate)].filter(
    (cert): cert is MailCertificateInfo => cert !== null,
  );
  const earliest = Math.min(...certificates.map((cert) => new Date(cert.expiresAt).getTime()));
  if (earliest <= now) {
    return {
      ...health,
      status: "fail",
      reason: "expired",
      detail: "The mail certificate has expired. Renew it to restore secure mail connections.",
    };
  }
  if (health.status === "fail") return health;
  const age = now - new Date(health.checkedAt).getTime();
  if (!Number.isFinite(age) || age > 24 * 60 * 60 * 1000) {
    return {
      ...health,
      status: "unknown",
      reason: "unavailable",
      detail:
        "The mail certificate has not been checked in the last 24 hours. Recheck the mail server.",
    };
  }
  if (health.status === "unknown") return health;
  if (earliest <= now + renewBeforeDays * 86_400_000) {
    return {
      ...health,
      status: "warn",
      reason: "expiring",
      detail: "The mail certificate is due for renewal.",
    };
  }
  return health;
}
