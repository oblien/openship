import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { X509Certificate } from "node:crypto";
import type { CommandExecutor } from "@repo/adapters";
import {
  SYSTEM,
  currentMailCertificateHealth,
  safeErrorMessage,
  type MailCertificateHealth,
  type MailCertificateInfo,
} from "@repo/core";
import { mailEngineCommand, requireMailEngine, resolveMailMutationAccess } from "./mail-engine";

const sq = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export function assertMailCertificateHostname(hostname: string): void {
  if (!/^mail\.[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname) || hostname.includes("..")) {
    throw new Error("Invalid mail certificate hostname");
  }
}

const ENDPOINTS = [
  { protocol: "smtp", port: 587, starttls: " -starttls smtp" },
  { protocol: "smtps", port: 465, starttls: "" },
  { protocol: "imap", port: 993, starttls: "" },
] as const;

/** Only public PEMs and TLS diagnostics leave the server. Each handshake is bounded. */
export function mailCertificateProbeCommand(hostname: string): string {
  assertMailCertificateHostname(hostname);
  return [
    `echo OPENSHIP_CERT_disk_BEGIN`,
    `if [ -r ${sq(`/etc/letsencrypt/live/${hostname}/fullchain.pem`)} ]; then cat ${sq(`/etc/letsencrypt/live/${hostname}/fullchain.pem`)}; else echo OPENSHIP_CERT_MISSING; fi`,
    `echo OPENSHIP_CERT_disk_END`,
    ...ENDPOINTS.flatMap(({ protocol, port, starttls }) => [
      `echo OPENSHIP_CERT_${protocol}_BEGIN`,
      `timeout 6 openssl s_client${starttls} -connect 127.0.0.1:${port} -servername ${sq(hostname)} -verify_hostname ${sq(hostname)} -showcerts </dev/null 2>&1 || true`,
      `echo OPENSHIP_CERT_${protocol}_END`,
    ]),
  ].join("\n");
}

function block(output: string, name: string): string {
  return (
    output.split(`OPENSHIP_CERT_${name}_BEGIN\n`)[1]?.split(`OPENSHIP_CERT_${name}_END`)[0] ?? ""
  );
}

function certificateInfo(
  output: string,
  hostname: string,
): { certificate: MailCertificateInfo | null; matches: boolean } {
  const pem = output.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
  if (!pem) return { certificate: null, matches: false };
  try {
    const cert = new X509Certificate(pem);
    return {
      certificate: {
        expiresAt: new Date(cert.validTo).toISOString(),
        issuer: cert.issuer.replace(/\n/g, ", "),
        fingerprint: cert.fingerprint256,
      },
      matches: !!cert.checkHost(hostname) && new Date(cert.validFrom).getTime() <= Date.now(),
    };
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/mail/mail-certificate-probe");
    return { certificate: null, matches: false };
  }
}

export function parseMailCertificateProbe(hostname: string, output: string): MailCertificateHealth {
  const disk = certificateInfo(block(output, "disk"), hostname);
  const health: MailCertificateHealth = {
    hostname,
    checkedAt: new Date().toISOString(),
    certificate: disk.certificate,
    status: "ok",
    endpoints: ENDPOINTS.map(({ protocol, port }) => {
      const raw = block(output, protocol);
      const parsed = certificateInfo(raw, hostname);
      const trusted = parsed.matches && /Verify return code: 0 \(ok\)/.test(raw);
      const detail = !parsed.certificate
        ? `Could not complete the TLS handshake on port ${port}.`
        : !trusted
          ? `The certificate served on port ${port} failed hostname or chain validation.`
          : undefined;
      return {
        protocol,
        port,
        certificate: parsed.certificate,
        trusted,
        ...(detail ? { detail } : {}),
      };
    }),
  };
  if (!disk.certificate) {
    health.status = block(output, "disk").includes("OPENSHIP_CERT_MISSING") ? "fail" : "unknown";
    health.reason = health.status === "fail" ? "missing" : "unavailable";
    health.detail = "The managed mail certificate could not be read on this server.";
  } else if (!disk.matches || health.endpoints.some((p) => p.certificate && !p.trusted)) {
    health.status = "fail";
    health.reason = "untrusted";
    health.detail =
      "The mail certificate failed hostname or chain validation. Renew it and check the mail service configuration.";
  } else if (
    health.endpoints.some(
      (p) => p.certificate && p.certificate.fingerprint !== disk.certificate?.fingerprint,
    )
  ) {
    health.status = "fail";
    health.reason = "not_loaded";
    health.detail =
      "A mail service is still serving a different certificate from the one on disk. Renew to reload the mail services.";
  } else if (health.endpoints.some((p) => !p.certificate)) {
    health.status = "unknown";
    health.reason = "unavailable";
    health.detail =
      "SMTP or IMAP TLS could not be checked. Check mail service health and recheck the certificate.";
  }
  return currentMailCertificateHealth(health, SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS)!;
}

export async function checkMailCertificate(
  executor: CommandExecutor,
  hostname: string,
): Promise<MailCertificateHealth> {
  try {
    const { flavor } = await requireMailEngine(executor);
    const output = await executor.exec(
      mailEngineCommand(flavor, `sh -c ${sq(mailCertificateProbeCommand(hostname))}`),
      { timeout: 25_000 },
    );
    return parseMailCertificateProbe(hostname, output);
  } catch (error) {
    observeCaughtError(error, "platform/engine/modules/mail/mail-certificate-probe");
    return {
      hostname,
      checkedAt: new Date().toISOString(),
      status: "unknown",
      reason: "unavailable",
      detail: safeErrorMessage(error).slice(0, 500),
      certificate: null,
      endpoints: [],
    };
  }
}

/** Setup and renewal share the same certificate wiring and daemon reload. */
export async function configureMailCertificate(
  executor: CommandExecutor,
  hostname: string,
): Promise<void> {
  assertMailCertificateHostname(hostname);
  const { flavor } = await requireMailEngine(executor);
  const access = await resolveMailMutationAccess(executor, flavor);
  const dir = `/etc/letsencrypt/live/${hostname}`;
  await access.hostFiles.exec("chmod 0755 /etc/letsencrypt/live /etc/letsencrypt/archive");
  const script = `set -eu
test -s ${sq(`${dir}/fullchain.pem`)}
test -s ${sq(`${dir}/privkey.pem`)}
openssl x509 -in ${sq(`${dir}/fullchain.pem`)} -noout -checkend 0
openssl x509 -in ${sq(`${dir}/fullchain.pem`)} -noout -checkhost ${sq(hostname)}
cert_public=$(openssl x509 -in ${sq(`${dir}/fullchain.pem`)} -pubkey -noout | openssl dgst -sha256)
key_public=$(openssl pkey -in ${sq(`${dir}/privkey.pem`)} -pubout | openssl dgst -sha256)
test "$cert_public" = "$key_public"
for file in /etc/ssl/certs/iRedMail.crt /etc/ssl/private/iRedMail.key; do
  if [ -f "$file" ] && [ ! -L "$file" ] && [ ! -e "$file.bak" ]; then cp -p "$file" "$file.bak"; fi
done
ln -sfn ${sq(`${dir}/fullchain.pem`)} /etc/ssl/certs/iRedMail.crt
ln -sfn ${sq(`${dir}/privkey.pem`)} /etc/ssl/private/iRedMail.key
postfix reload
doveadm reload`;
  await access.engineExec.exec(mailEngineCommand(flavor, `sh -c ${sq(script)}`), {
    timeout: 30_000,
  });
}

/** Retire only a legacy timer dedicated to this mail certificate. Other lineages
 * remain operator-owned; never disable their renewals to claim this one. */
export async function retireLegacyMailRenewal(
  executor: CommandExecutor,
  hostname: string,
): Promise<void> {
  assertMailCertificateHostname(hostname);
  const state = await executor.exec(
    "systemctl is-enabled certbot.timer 2>/dev/null || true\nsystemctl is-active certbot.timer 2>/dev/null || true",
  );
  if (!state.split("\n").some((line) => ["enabled", "active"].includes(line.trim()))) return;
  const { flavor } = await requireMailEngine(executor);
  const { hostFiles } = await resolveMailMutationAccess(executor, flavor);
  await hostFiles.exec(
    `sh -c ${sq(`set -eu
if systemctl is-active --quiet certbot.service; then
  echo 'The legacy Certbot renewal is running. Retry after it finishes.' >&2
  exit 1
fi
for conf in /etc/letsencrypt/renewal/*.conf; do
  [ -e "$conf" ] || continue
  lineage=$(basename "$conf" .conf)
  if [ ! "/etc/letsencrypt/live/$lineage/fullchain.pem" -ef ${sq(`/etc/letsencrypt/live/${hostname}/fullchain.pem`)} ]; then
    echo 'The host Certbot timer also manages other certificates. Migrate that timer before enabling Openship mail renewal; it has been left unchanged.' >&2
    exit 1
  fi
done
systemctl disable --now certbot.timer`)} `,
    { timeout: 15_000 },
  );
}
