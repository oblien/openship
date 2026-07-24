/**
 * Outbound SMTP relay (smarthost) config for a self-hosted mail server — the
 * "split delivery" model: this server keeps RECEIVING (port 25 + IMAP), but
 * SENDING is relayed through a trusted SMTP provider (Amazon SES flagship; any
 * SMTP relay via `provider:"custom"`). Fixes the #1 self-hosted problem —
 * fresh-VPS IPs blocklisted / outbound :25 blocked.
 *
 * Postfix config applied over SSH:
 *   /etc/postfix/sasl_passwd  =  [<host>]:<port> <user>:<pass>
 *   postconf -e relayhost=[<host>]:<port> smtp_sasl_auth_enable=yes
 *              smtp_sasl_password_maps=hash:/etc/postfix/sasl_passwd
 *              smtp_sasl_security_options=noanonymous
 *              smtp_tls_security_level=encrypt
 *   postmap + systemctl reload postfix
 *
 * SECURITY (see security-invariants): the SASL credentials are operator-
 * supplied and attacker-influenceable. They are written via `exec.writeFile`
 * (SFTP — NO shell), never interpolated into a shell string. Only fixed
 * commands + the regex-validated host run through the shell. We also reject
 * newline / `:` injection into the sasl_passwd line so the map can't be
 * corrupted. amavis keeps signing DKIM before Postfix hands off, so DMARC
 * still passes on DKIM alignment through the relay.
 */

import type { CommandExecutor } from "@repo/adapters";
import { encrypt } from "../../../lib/encryption";
import {
  readState,
  mutateState,
  type MailServerState,
  type OutboundRelay,
  type PersistedDnsRecord,
} from "../mail-state";
import { execute, q } from "./psql-runner";

const SASL_PASSWD_PATH = "/etc/postfix/sasl_passwd";
const SES_INCLUDE = "include:amazonses.com";

/** Single-quote-wrap for the one shell-interpolated value (the validated host). */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface ConfigureRelayInput {
  provider: "ses" | "custom";
  /** SES region (ses). Derives host `email-smtp.<region>.amazonaws.com`. */
  region?: string;
  /** Relay host — required for custom; derived from region for ses. */
  host?: string;
  port: number;
  /** SASL username (SES SMTP username — NOT an AWS access key). */
  username: string;
  /** Plaintext SASL password — encrypted before it hits state; never persisted raw. */
  password: string;
  /** Routing scope: "all" domains (global relayhost) or only `domains` (per-sender). Default "all". */
  scope?: "all" | "selected";
  /** Domains that route through the relay when scope="selected". */
  domains?: string[];
  /** Custom MAIL FROM subdomain for the PRIMARY domain (SES alignment). */
  mailFromDomain?: string;
  /** SES DKIM CNAMEs for the PRIMARY domain, pasted from the AWS console. */
  sesDkim?: { name: string; value: string }[];
  /** Per-additional-domain SES identity (each SES domain is verified separately). */
  identities?: Record<string, { mailFromDomain?: string; sesDkim?: { name: string; value: string }[] }>;
}

/** A single domain's SES identity records (primary uses the top-level fields). */
type RelayIdentity = { mailFromDomain?: string; sesDkim?: { name: string; value: string }[] };

const HOST_RE = /^[A-Za-z0-9.-]{1,255}$/;
const REGION_RE = /^[a-z0-9-]{1,32}$/;
// DNS names/targets — underscores are valid in labels like `_domainkey`.
const DOMAIN_RE = /^[A-Za-z0-9._-]{1,255}$/;

/** Resolve + validate the effective relay host from the input. */
function resolveHost(input: ConfigureRelayInput): string {
  if (input.provider === "ses") {
    if (!input.region || !REGION_RE.test(input.region)) {
      throw new Error("A valid SES region is required (e.g. us-east-1).");
    }
    return `email-smtp.${input.region}.amazonaws.com`;
  }
  if (!input.host || !HOST_RE.test(input.host)) {
    throw new Error("A valid relay host is required.");
  }
  return input.host;
}

function validate(input: ConfigureRelayInput): void {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("Relay port must be between 1 and 65535.");
  }
  // No whitespace or ':' in the username — ':' is the user:pass separator, and
  // any whitespace/newline would corrupt the sasl_passwd map line.
  if (!input.username || /[\s:]/.test(input.username)) {
    throw new Error("Relay username must not contain spaces or a colon.");
  }
  // Password may contain most chars, but a newline would inject a second map
  // entry. Reject CR/LF.
  if (!input.password || /[\r\n]/.test(input.password)) {
    throw new Error("Relay password is required and must be a single line.");
  }
  for (const d of input.domains ?? []) {
    if (!DOMAIN_RE.test(d)) throw new Error(`Invalid relay domain: ${d}`);
  }
  // Validate the primary identity + every per-domain identity.
  const identities: Array<[string, RelayIdentity]> = [
    ["", { mailFromDomain: input.mailFromDomain, sesDkim: input.sesDkim }],
    ...Object.entries(input.identities ?? {}),
  ];
  for (const [dom, id] of identities) {
    if (dom && !DOMAIN_RE.test(dom)) throw new Error(`Invalid identity domain: ${dom}`);
    if (id.mailFromDomain && !DOMAIN_RE.test(id.mailFromDomain)) {
      throw new Error("MAIL FROM domain is invalid.");
    }
    for (const c of id.sesDkim ?? []) {
      if (!DOMAIN_RE.test(c.name) || !DOMAIN_RE.test(c.value)) {
        throw new Error("SES DKIM CNAME name/value is invalid.");
      }
    }
  }
}

/** Add `include:amazonses.com` to an SPF value ahead of the `all` qualifier (idempotent). */
export function withSesInclude(spfValue: string): string {
  if (spfValue.includes(SES_INCLUDE)) return spfValue;
  const m = spfValue.match(/([~\-?+]all)\s*$/);
  if (m) return spfValue.replace(/\s*[~\-?+]all\s*$/, ` ${SES_INCLUDE} ${m[1]}`);
  return `${spfValue} ${SES_INCLUDE}`;
}

/** Remove the SES include token from an SPF value (idempotent). */
export function withoutSesInclude(spfValue: string): string {
  return spfValue
    .replace(new RegExp(`\\s*${SES_INCLUDE.replace(/[.]/g, "\\.")}`, "g"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * SES send-hop extras for ONE domain's identity: its DKIM CNAMEs + (optional)
 * MAIL FROM MX/TXT. SES is per-identity, so each relayed domain has its own set.
 */
export function identityExtraRecords(
  identity: RelayIdentity,
  provider: "ses" | "custom",
  region: string | undefined,
): PersistedDnsRecord[] {
  const extras: PersistedDnsRecord[] = [];
  for (const c of identity.sesDkim ?? []) {
    extras.push({ type: "CNAME", name: c.name, value: c.value, required: true });
  }
  if (provider === "ses" && identity.mailFromDomain && region) {
    extras.push({ type: "MX", name: identity.mailFromDomain, value: `feedback-smtp.${region}.amazonaws.com`, priority: 10, required: false });
    extras.push({ type: "TXT", name: identity.mailFromDomain, value: "v=spf1 include:amazonses.com ~all", required: false });
  }
  return extras;
}

/** Shape shared by the primary `dnsRecords` (loose) and additional `DnsRecordSet`. */
type PatchableRecords = { spf?: { value?: string }; extraRecords?: PersistedDnsRecord[] };

/** Patch ONE domain's record set to show the relay send-hop (SPF include + extras). */
function applyRelayDnsForDomain(
  records: PatchableRecords,
  identity: RelayIdentity,
  provider: "ses" | "custom",
  region: string | undefined,
): PatchableRecords {
  const out: PatchableRecords = { ...records };
  if (out.spf && typeof out.spf.value === "string") {
    out.spf = { ...out.spf, value: withSesInclude(out.spf.value) };
  }
  const extras = identityExtraRecords(identity, provider, region);
  if (extras.length) out.extraRecords = extras;
  else delete out.extraRecords;
  return out;
}

/** Undo `applyRelayDnsForDomain` for ONE domain — strip the include + drop extras. */
function revertRelayDnsForDomain(records: PatchableRecords | null | undefined): PatchableRecords | null | undefined {
  if (!records) return records;
  const out: PatchableRecords = { ...records };
  if (out.spf && typeof out.spf.value === "string") {
    out.spf = { ...out.spf, value: withoutSesInclude(out.spf.value) };
  }
  delete out.extraRecords;
  return out;
}

/**
 * Recompute the SES send-hop DNS across a whole mail-server state from a
 * persisted `OutboundRelay` — SPF `include` + SES DKIM/MAIL FROM extras on every
 * relayed domain (primary + additional), reverting the rest. Pure (no I/O).
 *
 * This is the SINGLE source of the relay→DNS mapping: `configureOutboundRelay`
 * uses it after writing Postfix, and the DKIM-rebuild / domain-add hooks re-run
 * it so a freshly rebuilt `dnsRecords` (which is otherwise self-host-only)
 * doesn't silently drop the SES records. Idempotent — safe to re-apply.
 */
export function applyRelayToState(
  state: MailServerState,
  relay: OutboundRelay,
): Pick<MailServerState, "dnsRecords" | "additionalDomains"> {
  const primary = state.domain;
  const additionalKeys = Object.keys(state.additionalDomains ?? {});
  const scope = relay.scope === "selected" ? "selected" : "all";
  const relayed = new Set(
    scope === "all" ? [primary, ...additionalKeys] : (relay.domains ?? []),
  );
  const identityFor = (domain: string): RelayIdentity =>
    domain === primary
      ? { mailFromDomain: relay.mailFromDomain, sesDkim: relay.sesDkim }
      : relay.identities?.[domain] ?? {};

  const dnsRecords = relayed.has(primary)
    ? applyRelayDnsForDomain(
        { ...(state.dnsRecords ?? {}) } as PatchableRecords,
        identityFor(primary),
        relay.provider,
        relay.region,
      )
    : revertRelayDnsForDomain(state.dnsRecords as PatchableRecords | null);

  const additionalDomains = { ...(state.additionalDomains ?? {}) };
  for (const d of additionalKeys) {
    const entry = additionalDomains[d];
    if (!entry) continue;
    const patched = relayed.has(d)
      ? applyRelayDnsForDomain(entry.records as unknown as PatchableRecords, identityFor(d), relay.provider, relay.region)
      : revertRelayDnsForDomain(entry.records as unknown as PatchableRecords);
    additionalDomains[d] = { ...entry, records: patched as unknown as typeof entry.records };
  }

  return {
    dnsRecords: (dnsRecords ?? null) as MailServerState["dnsRecords"],
    additionalDomains,
  };
}

/**
 * Enable / update the outbound relay on the mail server. Idempotent —
 * re-running with new creds rewrites the map + reloads. Returns the updated
 * state (relay block masked-free is the caller's job via `getOutboundRelay`).
 */
export async function configureOutboundRelay(
  exec: CommandExecutor,
  input: ConfigureRelayInput,
): Promise<MailServerState> {
  validate(input);
  const host = resolveHost(input);
  const scope: "all" | "selected" = input.scope === "selected" ? "selected" : "all";
  const nexthop = `[${host}]:${input.port}`;

  // 1) Write the SASL map via SFTP (creds never touch a shell string). One
  //    entry per relay host covers both global and per-sender routing.
  await exec.writeFile(SASL_PASSWD_PATH, `${nexthop} ${input.username}:${input.password}\n`);

  // 2) Lock down + hash the map (fixed paths, no interpolation).
  await exec.exec(
    `chmod 600 ${SASL_PASSWD_PATH} && postmap ${SASL_PASSWD_PATH} && chmod 600 ${SASL_PASSWD_PATH}.db`,
  );

  // 3) SASL/TLS client directives always; the GLOBAL relayhost only in "all"
  //    scope. In "selected" scope we clear the global relayhost so unmatched
  //    domains deliver direct, and route the chosen domains via `sender_relayhost`.
  const sasl = [
    "smtp_sasl_auth_enable=yes",
    `smtp_sasl_password_maps=hash:${SASL_PASSWD_PATH}`,
    "smtp_sasl_security_options=noanonymous",
    "smtp_tls_security_level=encrypt",
  ];
  if (input.port === 465) sasl.push("smtp_tls_wrappermode=yes"); // implicit-TLS submission

  if (scope === "all") {
    await exec.exec(`postconf -e ${[`relayhost=${nexthop}`, ...sasl].map(sq).join(" ")}`);
    // No per-sender rows for this relay host when routing everything globally.
    await execute(exec, `DELETE FROM sender_relayhost WHERE relayhost = ${q(nexthop)}`).catch(() => {});
  } else {
    await exec.exec("postconf -X relayhost 2>/dev/null || true");
    await exec.exec(`postconf -e ${sasl.map(sq).join(" ")}`);
    const selected = (input.domains ?? []).map((d) => `@${d}`);
    for (const account of selected) {
      await execute(
        exec,
        `INSERT INTO sender_relayhost (account, relayhost) VALUES (${q(account)}, ${q(nexthop)}) ` +
          `ON CONFLICT (account) DO UPDATE SET relayhost = EXCLUDED.relayhost`,
      );
    }
    // Drop rows for this relay host whose domain was de-selected.
    const notIn = selected.length ? ` AND account NOT IN (${selected.map(q).join(", ")})` : "";
    await execute(exec, `DELETE FROM sender_relayhost WHERE relayhost = ${q(nexthop)}${notIn}`).catch(() => {});
  }

  // 4) Reload Postfix.
  await exec.exec("systemctl reload postfix 2>/dev/null || postfix reload");

  // 5) Persist the relay block (encrypted password) + fan DNS across every
  //    relayed domain (primary + additional).
  const state = await readState(exec);
  if (!state) throw new Error("Mail server state not found — is mail provisioned on this server?");

  const relay: OutboundRelay = {
    enabled: true,
    provider: input.provider,
    region: input.region,
    host,
    port: input.port,
    username: input.username,
    passwordEncrypted: encrypt(input.password),
    scope,
    domains: scope === "selected" ? (input.domains ?? []) : undefined,
    mailFromDomain: input.mailFromDomain,
    sesDkim: input.sesDkim,
    identities: input.identities,
    updatedAt: new Date().toISOString(),
  };

  const next = await mutateState(exec, state.serverId, (s) => {
    // Single source of the relay→DNS mapping (see applyRelayToState).
    const { dnsRecords, additionalDomains } = applyRelayToState(s, relay);
    return { ...s, outboundRelay: relay, dnsRecords, additionalDomains };
  });
  if (!next) throw new Error("Failed to persist relay config.");
  return next;
}

/** Disable the outbound relay — revert Postfix to direct-to-MX + clear state. */
export async function disableOutboundRelay(exec: CommandExecutor): Promise<MailServerState | null> {
  // Remove the relay-specific directives (leave smtp_tls_security_level — it's
  // good hygiene for direct delivery too and reverting it could weaken TLS).
  await exec.exec(
    "postconf -X relayhost smtp_sasl_auth_enable smtp_sasl_password_maps smtp_sasl_security_options smtp_tls_wrappermode 2>/dev/null || true",
  );
  await exec.exec(`rm -f ${SASL_PASSWD_PATH} ${SASL_PASSWD_PATH}.db`);

  // Delete the per-sender rows we own for this relay host (no `active` column —
  // presence = active, so disable must DELETE rather than deactivate).
  const pre = await readState(exec);
  const relay = pre?.outboundRelay;
  if (relay?.host) {
    const nexthop = `[${relay.host}]:${relay.port}`;
    await execute(exec, `DELETE FROM sender_relayhost WHERE relayhost = ${q(nexthop)}`).catch(() => {});
  }

  await exec.exec("systemctl reload postfix 2>/dev/null || postfix reload");

  const state = await readState(exec);
  if (!state) return null;
  return mutateState(exec, state.serverId, (s) => {
    // Revert the send-hop DNS on every domain (primary + additional).
    const additionalDomains = { ...(s.additionalDomains ?? {}) };
    for (const d of Object.keys(additionalDomains)) {
      const entry = additionalDomains[d];
      if (!entry) continue;
      const reverted = revertRelayDnsForDomain(entry.records as unknown as PatchableRecords);
      additionalDomains[d] = { ...entry, records: reverted as unknown as typeof entry.records };
    }
    const next = {
      ...s,
      dnsRecords: (revertRelayDnsForDomain(s.dnsRecords as PatchableRecords | null) ?? null) as MailServerState["dnsRecords"],
      additionalDomains,
    };
    delete (next as { outboundRelay?: OutboundRelay }).outboundRelay;
    return next;
  });
}

/** Masked read for the admin UI — never returns the encrypted password. */
export async function getOutboundRelay(
  exec: CommandExecutor,
): Promise<(Omit<OutboundRelay, "passwordEncrypted"> & { hasPassword: boolean }) | null> {
  const state = await readState(exec);
  const relay = state?.outboundRelay;
  if (!relay) return null;
  const { passwordEncrypted, ...rest } = relay;
  return { ...rest, hasPassword: !!passwordEncrypted };
}
