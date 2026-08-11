/**
 * Per-domain DNS-records record-keeping for the mail admin panel's
 * "add a new domain" flow.
 *
 * Adding a domain to an existing mail server is just an INSERT into
 * `vmail.domain` - Postfix accepts mail for it as soon as the row exists.
 * The only operator-facing work is publishing the MX/SPF/DMARC records
 * for the new domain so external senders can reach it and pass alignment.
 *
 * We persist that record set in the on-server `MailServerState.additionalDomains`
 * map so the dashboard's "publish DNS records" banner can render until the
 * operator clicks "I've set the records - continue". The banner mirrors the
 * install-step DNS hold banner.
 *
 * DKIM is intentionally NOT auto-provisioned for additional domains. iRedMail
 * uses per-domain keys generated via `amavisd genrsa` - running that from
 * within openship requires editing /etc/amavis/conf.d/50-user, reloading
 * amavis, and managing key paths on disk. That's a separate operator action
 * (or future feature) - for now we surface the three records that actually
 * need to be live for mail to flow.
 */

import { sshManager } from "../../../lib/ssh-manager";
import { readState, mutateState } from "../mail-state";
import type { DnsRecordSet, AdditionalDomainDns } from "../mail-state";
import { buildSpfValue } from "../mail.service";
import { withSesInclude } from "./outbound-relay.service";

// ─── Record set construction ─────────────────────────────────────────────────

/**
 * Compose the DNS-records bundle for an additional domain.
 *
 * The `installDomain` is the primary domain the mail server was provisioned
 * on (e.g. `oblien.com`). The MX record for any additional domain points
 * back to `mail.<installDomain>` since that's the only hostname with an MX
 * target + SSL cert. DKIM is optional - pass `dkimValue` when amavis has
 * been provisioned with a keypair for `newDomain`; omit it to surface a
 * 3-record banner (MX/SPF/DMARC).
 *
 * The optional `ipv4` / `ipv6` are the mail host's public IPs (the same
 * ones the primary install published as `A`/`AAAA` for `mail.<installDomain>`).
 * When provided, they're spliced into the SPF record alongside `mx` so
 * receivers can authorize without an extra MX→A lookup and so a brief
 * MX-resolution hiccup doesn't drop SPF=pass. The same SPF shape is used
 * for the primary install in step 11.
 */
export function buildDomainDnsRecords(
  installDomain: string,
  newDomain: string,
  dkimValue?: string,
  ipv4?: string | null,
  ipv6?: string | null,
  opts?: { sesInclude?: boolean },
): DnsRecordSet {
  const mailHost = `mail.${installDomain}`;
  const spfValue = opts?.sesInclude
    ? withSesInclude(buildSpfValue(ipv4, ipv6))
    : buildSpfValue(ipv4, ipv6);
  return {
    mx: {
      type: "MX",
      name: newDomain,
      priority: 10,
      value: mailHost,
      required: true,
    },
    spf: {
      type: "TXT",
      name: newDomain,
      value: spfValue,
      required: true,
    },
    ...(dkimValue && {
      dkim: {
        type: "TXT",
        name: `dkim._domainkey.${newDomain}`,
        value: dkimValue,
        required: true,
      },
    }),
    dmarc: {
      type: "TXT",
      name: `_dmarc.${newDomain}`,
      value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${newDomain}`,
      required: true,
    },
  };
}

// ─── Per-domain DNS state persistence ────────────────────────────────────────

/**
 * Persist a freshly-generated record bundle for `domain` into the
 * on-server state file. Initial state is `acknowledgedAt: null` - the
 * dashboard's banner uses that to keep showing the "publish DNS" prompt
 * until the operator clicks "I've set the records".
 *
 * `postmasterPassword` is the auto-generated plaintext for the
 * `postmaster@<domain>` mailbox `createDomain` provisions at the same
 * time. The welcome test-email flow reads it to authenticate over SMTP
 * submission so the test message is sent AS the new domain (DKIM signs,
 * SPF aligns, DMARC passes). The install domain's equivalent lives in
 * `secrets.DOMAIN_ADMIN_PASSWD_PLAIN`.
 */
export async function recordDomainDns(
  serverId: string,
  domain: string,
  records: DnsRecordSet,
  postmasterPassword?: string,
): Promise<void> {
  await sshManager.withExecutor(serverId, async (exec) => {
    const result = await mutateState(exec, serverId, (state) => ({
      ...state,
      additionalDomains: {
        ...(state.additionalDomains ?? {}),
        [domain]: {
          records,
          acknowledgedAt: null,
          createdAt: new Date().toISOString(),
          ...(postmasterPassword ? { postmasterPassword } : {}),
        },
      },
    }));
    if (!result) {
      throw new Error(
        "Mail state file not found - can't record DNS records for new domain.",
      );
    }
  });
}

/**
 * Look up the saved DNS state for a domain. Returns null if no record set
 * was ever generated for it (e.g. primary install domain - that lives in
 * `state.dnsRecords` instead).
 */
export async function getDomainDnsState(
  serverId: string,
  domain: string,
): Promise<AdditionalDomainDns | null> {
  return sshManager.withExecutor(serverId, async (exec) => {
    const state = await readState(exec);
    if (!state) return null;
    return state.additionalDomains?.[domain] ?? null;
  });
}

/**
 * Mark a domain's DNS records as published by the operator. Sets
 * `acknowledgedAt` to now; the banner stops rendering once this flips.
 *
 * Idempotent - a second ack is a no-op (we don't bump the timestamp).
 */
export async function acknowledgeDomainDns(
  serverId: string,
  domain: string,
): Promise<void> {
  await sshManager.withExecutor(serverId, async (exec) => {
    const result = await mutateState(exec, serverId, (state) => {
      const existing = state.additionalDomains?.[domain];
      if (!existing) {
        throw new Error(`No saved DNS state for ${domain}`);
      }
      if (existing.acknowledgedAt) return state; // already acknowledged — no change
      return {
        ...state,
        additionalDomains: {
          ...state.additionalDomains,
          [domain]: { ...existing, acknowledgedAt: new Date().toISOString() },
        },
      };
    });
    if (!result) {
      throw new Error("Mail state file not found.");
    }
  });
}

/**
 * Clear the persisted DNS state for a domain. Called from `deleteDomain`
 * so the banner doesn't keep showing up after the domain row is gone.
 */
export async function deleteDomainDns(
  serverId: string,
  domain: string,
): Promise<void> {
  await sshManager.withExecutor(serverId, async (exec) => {
    await mutateState(exec, serverId, (state) => {
      if (!state.additionalDomains?.[domain]) return state;
      const { [domain]: _, ...rest } = state.additionalDomains;
      return { ...state, additionalDomains: rest };
    });
  });
}

/**
 * Convenience: list every additional domain that still has DNS pending
 * (acknowledgedAt == null). The Domains tab uses this to render banners
 * above the table in one shot rather than fetching per-row.
 */
export async function listPendingDomainDns(
  serverId: string,
): Promise<Array<{ domain: string; state: AdditionalDomainDns }>> {
  return sshManager.withExecutor(serverId, async (exec) => {
    const state = await readState(exec);
    if (!state || !state.additionalDomains) return [];
    return Object.entries(state.additionalDomains)
      .filter(([, ad]) => !ad.acknowledgedAt)
      .map(([domain, ad]) => ({ domain, state: ad }));
  });
}
