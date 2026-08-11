/**
 * Outbound SMTP relay (smarthost) config for a self-hosted mail server — the
 * "split delivery" model: this server keeps RECEIVING (port 25 + IMAP), but
 * SENDING is relayed through a trusted SMTP provider (Amazon SES flagship; any
 * SMTP relay via `provider:"custom"`). Fixes the #1 self-hosted problem —
 * fresh-VPS IPs blocklisted / outbound :25 blocked.
 *
 * Two routing scopes, and they are configured DIFFERENTLY on purpose:
 *
 *   scope "all"      — a global `relayhost`. Every message leaves via the relay,
 *                      so relay-grade TLS (and implicit TLS on :465) can safely be
 *                      global too: there is no other outbound path to break.
 *
 *   scope "selected" — no global relayhost. Chosen envelope senders — whole
 *                      domains (`@example.com`) AND individual addresses
 *                      (`contact@example.com`) — get `sender_relayhost` rows and
 *                      go out via the provider; everything else keeps delivering
 *                      direct-to-MX. That is the `contact@` case: the mailbox is
 *                      hosted (IMAP) here, only its SENDING is someone else's.
 *
 * Because "selected" leaves a direct path alive, its TLS settings must NOT be
 * global. Two ways that goes wrong if they are:
 *   - `smtp_tls_security_level=encrypt` globally defers mail to any MX without
 *     STARTTLS — domains that never asked to relay stop delivering.
 *   - `smtp_tls_wrappermode=yes` (needed for :465) globally speaks implicit TLS
 *     to *every* MX on port 25, which breaks all direct delivery.
 * So in "selected" scope the global level stays opportunistic (`may`) and the
 * relay hop is pinned to `encrypt` through a per-nexthop `smtp_tls_policy_maps`
 * entry — which is what keeps the SASL password off a plaintext connection.
 * Implicit-TLS :465 has no per-destination form, so "selected" requires a
 * STARTTLS port (587/2587); every provider in the picker offers one.
 *
 * Postfix config applied over SSH:
 *   /etc/postfix/sasl_passwd        =  [<host>]:<port> <user>:<pass>
 *   /etc/postfix/openship_tls_policy = [<host>]:<port> encrypt   (selected only)
 *   postconf -e relayhost=[<host>]:<port>          (all scope only)
 *              smtp_sasl_auth_enable=yes
 *              smtp_sasl_password_maps=hash:/etc/postfix/sasl_passwd
 *              smtp_sasl_security_options=noanonymous
 *              smtp_tls_security_level=encrypt|may
 *              smtp_tls_policy_maps=hash:…          (selected only, merged)
 *   postmap + postfix reload
 *
 * WHERE those run is not decided here: `mailConfigFile` gives the write/read ends
 * of the map path and `mailEngineCommand` wraps the Postfix commands for whichever
 * engine the box has (`../mail-engine.ts` owns that matrix). On the container flavor
 * the map is written to the host end of a bind mount and hashed inside the engine;
 * on a legacy host-native box both are the same file and the commands run bare.
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
import {
  hasRelaySelection,
  IMPLICIT_TLS_PORT,
  implicitTlsUnsupported,
  isSenderAddress,
  normalizeSenderAddress,
  relayedDomainsFor,
  relayMailFromRecords,
  relayProvider,
  relayProviderSpfInclude,
  relaySenderKeys,
  resolveRelayHost,
  type RelayProviderId,
} from "@repo/core";
import { encrypt } from "../../../lib/encryption";
import {
  mailEngineCommand,
  mailConfigFile,
  requireMailEngine,
  type MailEngineFlavor,
} from "../mail-engine";
import {
  readState,
  mutateState,
  type MailServerState,
  type OutboundRelay,
  type PersistedDnsRecord,
} from "../mail-state";
import { execute, q } from "./psql-runner";

/**
 * Legacy include. Older builds hardcoded SES's token onto every relayed domain's
 * SPF — even for a non-SES relay — so it's always stripped before the current
 * provider's include is applied. That's a migration, not a policy: `dnsRecords`
 * is the record set WE generate and recommend, never a copy of the operator's
 * live zone, so removing a token we wrongly put there is safe.
 */
const SES_INCLUDE = "include:amazonses.com";

/** `postconf` parameter holding the per-nexthop TLS policy map (selected scope). */
const TLS_POLICY_PARAM = "smtp_tls_policy_maps";

/**
 * The flavor-specific halves of every command below, resolved once per operation.
 *
 * `saslMap.write` is where `exec.writeFile` (SFTP, no shell — the SASL-password
 * security invariant) lands the map; `saslMap.engine` is the path Postfix itself
 * reads, which is what `postmap`/`postconf` must reference. On the container flavor
 * those are the two ends of a bind mount; on a legacy box they're one file.
 * `tlsPolicy` is the same pair for the per-nexthop TLS policy map.
 *
 * Resolution goes through `requireMailEngine`, so a box with no engine — or a
 * stopped one, which can't hash a map or reload Postfix — fails as a typed 409 with
 * a remediation instead of a raw "No such container" 500.
 */
async function relayTransport(exec: CommandExecutor): Promise<{
  flavor: MailEngineFlavor;
  saslMap: { write: string; engine: string };
  tlsPolicy: { write: string; engine: string };
  engine: (cmd: string) => string;
}> {
  const { flavor } = await requireMailEngine(exec);
  return {
    flavor,
    saslMap: mailConfigFile(flavor, "saslPasswd"),
    tlsPolicy: mailConfigFile(flavor, "relayTlsPolicy"),
    engine: (cmd: string) => mailEngineCommand(flavor, cmd),
  };
}

/** Single-quote-wrap for the one shell-interpolated value (the validated host). */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface ConfigureRelayInput {
  /** Registry id (`@repo/core` RELAY_PROVIDERS) — `custom` for anything else. */
  provider: RelayProviderId;
  /** Region for regional providers (SES, OCI) — substituted into their host. */
  region?: string;
  /** Relay host. Required for `custom`, an override for fixed-host providers. */
  host?: string;
  port: number;
  /** SASL username (SES SMTP username — NOT an AWS access key). */
  username: string;
  /** Plaintext SASL password — encrypted before it hits state; never persisted raw. */
  password: string;
  /** Routing scope: "all" domains (global relayhost) or only `domains`/`addresses` (per-sender). Default "all". */
  scope?: "all" | "selected";
  /** Whole domains that route through the relay when scope="selected". */
  domains?: string[];
  /**
   * Individual envelope senders (`contact@example.com`) that route through the
   * relay when scope="selected", without relaying the rest of their domain. The
   * mailbox still RECEIVES here — only its sending is the provider's.
   */
  addresses?: string[];
  /**
   * SPF `include:` token the provider requires on every relayed domain
   * (`include:amazonses.com`, `include:sendgrid.net`, …). Blank = the provider
   * doesn't publish one (or the operator doesn't know it): we then leave SPF
   * alone rather than guessing a token that would fail the check.
   */
  spfInclude?: string;
  /** Custom MAIL FROM (bounce) subdomain for the PRIMARY domain. */
  mailFromDomain?: string;
  /**
   * Provider-issued DKIM CNAMEs for the PRIMARY domain, pasted from the
   * provider's console. Named `sesDkim` for state compatibility — it carries any
   * provider's domain-authentication CNAMEs.
   */
  sesDkim?: { name: string; value: string }[];
  /** Per-additional-domain identity (providers verify each domain separately). */
  identities?: Record<string, { mailFromDomain?: string; sesDkim?: { name: string; value: string }[] }>;
}

/** A single domain's provider identity records (primary uses the top-level fields). */
type RelayIdentity = { mailFromDomain?: string; sesDkim?: { name: string; value: string }[] };

const HOST_RE = /^[A-Za-z0-9.-]{1,255}$/;
const REGION_RE = /^[a-z0-9-]{1,32}$/;
// DNS names/targets — underscores are valid in labels like `_domainkey`.
const DOMAIN_RE = /^[A-Za-z0-9._-]{1,255}$/;
/**
 * Resolve + validate the effective relay host. The registry decides HOW (regional
 * template vs fixed vs operator-supplied); this only validates the result, since
 * the host is the one value that reaches a shell string.
 */
function resolveHost(input: ConfigureRelayInput): string {
  const spec = relayProvider(input.provider);
  if (spec.regional && (!input.region || !REGION_RE.test(input.region))) {
    throw new Error(`A valid ${spec.label} region is required (e.g. us-east-1).`);
  }
  const host = resolveRelayHost(input);
  if (!host || !HOST_RE.test(host)) {
    throw new Error("A valid relay host is required.");
  }
  return host;
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
  for (const a of input.addresses ?? []) {
    if (!isSenderAddress(a)) throw new Error(`Invalid relay sender address: ${a}`);
  }
  // An SPF include is published verbatim into a TXT record — it must be a single
  // mechanism token, not a whole policy fragment.
  if (input.spfInclude && !/^include:[A-Za-z0-9._-]{1,255}$/.test(input.spfInclude.trim())) {
    throw new Error('SPF include must look like "include:example.net".');
  }
  if (input.scope === "selected" && !hasRelaySelection(input)) {
    throw new Error("Select at least one domain or sender address to relay.");
  }
  // See `implicitTlsUnsupported`: :465 is a global client setting, so scoping the
  // relay to some senders while speaking implicit TLS is not expressible.
  if (implicitTlsUnsupported(input)) {
    throw new Error(
      "Port 465 (implicit TLS) can't be used when relaying only selected senders — " +
        "it would apply to all outbound mail. Use the provider's STARTTLS port (587) instead.",
    );
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

/**
 * The SPF `include:` token a relay needs on every domain it sends for — the
 * operator's override, else the provider registry's known token, else none (see
 * `relay-providers.ts` on why a guess is worse than nothing).
 */
export function relaySpfInclude(relay: {
  provider: RelayProviderId;
  spfInclude?: string;
}): string | undefined {
  return relayProviderSpfInclude(relay);
}

/** Add an SPF `include:` ahead of the `all` qualifier (idempotent, no-op if blank). */
export function withSpfInclude(spfValue: string, include: string | undefined): string {
  const token = include?.trim();
  if (!token || spfValue.includes(token)) return spfValue;
  const m = spfValue.match(/([~\-?+]all)\s*$/);
  if (m) return spfValue.replace(/\s*[~\-?+]all\s*$/, ` ${token} ${m[1]}`);
  return `${spfValue} ${token}`;
}

/**
 * Remove relay `include:` tokens from an SPF value (idempotent).
 *
 * Always strips the SES token plus any extra passed in — the extras are the
 * PREVIOUS relay's include, so switching provider (or disabling) doesn't leave a
 * stale third-party authorized to send as the domain.
 */
export function withoutSpfInclude(spfValue: string, ...includes: (string | undefined)[]): string {
  const tokens = new Set([SES_INCLUDE, ...includes.map((i) => i?.trim()).filter(Boolean) as string[]]);
  let out = spfValue;
  for (const token of tokens) {
    out = out.replace(new RegExp(`\\s*${token.replace(/[.\\+*?[\]^$(){}|/-]/g, "\\$&")}(?=\\s|$)`, "g"), "");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Send-hop extras for ONE domain's identity: the provider's DKIM CNAMEs +
 * (optional) MAIL FROM MX/TXT. Providers verify per domain, so each relayed
 * domain has its own set; whether MAIL FROM exists at all is registry data.
 */
export function identityExtraRecords(
  identity: RelayIdentity,
  provider: RelayProviderId,
  region: string | undefined,
): PersistedDnsRecord[] {
  const extras: PersistedDnsRecord[] = [];
  for (const c of identity.sesDkim ?? []) {
    extras.push({ type: "CNAME", name: c.name, value: c.value, required: true });
  }
  const mailFrom = relayMailFromRecords({ provider, region, mailFromDomain: identity.mailFromDomain });
  if (mailFrom) {
    extras.push({ type: "MX", name: identity.mailFromDomain!, value: mailFrom.mx, priority: 10, required: false });
    extras.push({ type: "TXT", name: identity.mailFromDomain!, value: mailFrom.spf, required: false });
  }
  return extras;
}

/** Shape shared by the primary `dnsRecords` (loose) and additional `DnsRecordSet`. */
type PatchableRecords = { spf?: { value?: string }; extraRecords?: PersistedDnsRecord[] };

/**
 * Which provider's send-hop to publish, and which one to stop publishing.
 * `stale` is the include from whatever relay was configured before, so a provider
 * switch swaps the token in one pass instead of accumulating includes.
 */
type RelayDnsOpts = {
  provider: RelayProviderId;
  region?: string;
  include?: string;
  stale?: string;
};

/** Patch ONE domain's record set to show the relay send-hop (SPF include + extras). */
function applyRelayDnsForDomain(
  records: PatchableRecords,
  identity: RelayIdentity,
  opts: RelayDnsOpts,
): PatchableRecords {
  const out: PatchableRecords = { ...records };
  if (out.spf && typeof out.spf.value === "string") {
    const base = withoutSpfInclude(out.spf.value, opts.stale, opts.include);
    out.spf = { ...out.spf, value: withSpfInclude(base, opts.include) };
  }
  const extras = identityExtraRecords(identity, opts.provider, opts.region);
  if (extras.length) out.extraRecords = extras;
  else delete out.extraRecords;
  return out;
}

/** Undo `applyRelayDnsForDomain` for ONE domain — strip the include + drop extras. */
function revertRelayDnsForDomain(
  records: PatchableRecords | null | undefined,
  ...includes: (string | undefined)[]
): PatchableRecords | null | undefined {
  if (!records) return records;
  const out: PatchableRecords = { ...records };
  if (out.spf && typeof out.spf.value === "string") {
    out.spf = { ...out.spf, value: withoutSpfInclude(out.spf.value, ...includes) };
  }
  delete out.extraRecords;
  return out;
}

/**
 * Recompute the relay send-hop DNS across a whole mail-server state from a
 * persisted `OutboundRelay` — SPF `include` + DKIM/MAIL FROM extras on every
 * relayed domain (primary + additional), reverting the rest. Pure (no I/O).
 *
 * A "relayed domain" in `selected` scope is any domain we route senders for,
 * whether that's the whole domain (`@example.com`) or just one address
 * (`contact@example.com`) — SPF is published per domain either way, so a single
 * relayed address is enough to need the include.
 *
 * This is the SINGLE source of the relay→DNS mapping: `configureOutboundRelay`
 * uses it after writing Postfix, and the DKIM-rebuild / domain-add hooks re-run
 * it so a freshly rebuilt `dnsRecords` (which is otherwise self-host-only)
 * doesn't silently drop the relay records. Idempotent — safe to re-apply.
 */
export function applyRelayToState(
  state: MailServerState,
  relay: OutboundRelay,
): Pick<MailServerState, "dnsRecords" | "additionalDomains"> {
  const primary = state.domain;
  const additionalKeys = Object.keys(state.additionalDomains ?? {});
  const scope = relay.scope === "selected" ? "selected" : "all";
  const relayed = new Set(
    scope === "all"
      ? [primary, ...additionalKeys]
      : relayedDomainsFor({ domains: relay.domains, addresses: relay.addresses }),
  );
  const identityFor = (domain: string): RelayIdentity =>
    domain === primary
      ? { mailFromDomain: relay.mailFromDomain, sesDkim: relay.sesDkim }
      : relay.identities?.[domain] ?? {};

  // The include the PREVIOUS config published, so a provider switch replaces its
  // token rather than stacking a second one.
  const stale = state.outboundRelay ? relaySpfInclude(state.outboundRelay) : undefined;
  const opts: RelayDnsOpts = {
    provider: relay.provider,
    region: relay.region,
    include: relaySpfInclude(relay),
    stale,
  };

  const dnsRecords = relayed.has(primary)
    ? applyRelayDnsForDomain({ ...(state.dnsRecords ?? {}) } as PatchableRecords, identityFor(primary), opts)
    : revertRelayDnsForDomain(state.dnsRecords as PatchableRecords | null, stale, opts.include);

  const additionalDomains = { ...(state.additionalDomains ?? {}) };
  for (const d of additionalKeys) {
    const entry = additionalDomains[d];
    if (!entry) continue;
    const patched = relayed.has(d)
      ? applyRelayDnsForDomain(entry.records as unknown as PatchableRecords, identityFor(d), opts)
      : revertRelayDnsForDomain(entry.records as unknown as PatchableRecords, stale, opts.include);
    additionalDomains[d] = { ...entry, records: patched as unknown as typeof entry.records };
  }

  return {
    dnsRecords: (dnsRecords ?? null) as MailServerState["dnsRecords"],
    additionalDomains,
  };
}

/** Read one postconf parameter's live value; "" when unset or unreadable. */
async function readParam(
  exec: CommandExecutor,
  engine: (cmd: string) => string,
  param: string,
): Promise<string> {
  const out = await exec.exec(engine(`postconf -h ${param}`)).catch(() => "");
  return (out ?? "").trim();
}

/**
 * Pin the relay hop to `encrypt` without touching global TLS: write a one-line
 * per-nexthop policy map and MERGE our `hash:` source into `smtp_tls_policy_maps`.
 * Merge, not set — an operator (or a future feature) may have their own map there,
 * and clobbering it would silently downgrade those destinations.
 */
async function pinRelayTlsPolicy(
  exec: CommandExecutor,
  engine: (cmd: string) => string,
  tlsPolicy: { write: string; engine: string },
  nexthop: string,
): Promise<string> {
  await exec.writeFile(tlsPolicy.write, `${nexthop} encrypt\n`);
  await exec.exec(engine(`postmap ${tlsPolicy.engine}`));
  const ours = `hash:${tlsPolicy.engine}`;
  const parts = (await readParam(exec, engine, TLS_POLICY_PARAM)).split(/[\s,]+/).filter(Boolean);
  if (!parts.includes(ours)) parts.push(ours);
  return parts.join(" ");
}

/**
 * Undo `pinRelayTlsPolicy`: drop only OUR map source (unsetting the parameter
 * entirely if we were its only entry — `postconf -e x=` leaves an empty value,
 * which is not the same as unset) and remove the map file.
 */
async function dropRelayTlsPolicy(
  exec: CommandExecutor,
  engine: (cmd: string) => string,
  tlsPolicy: { write: string; engine: string },
): Promise<void> {
  const ours = `hash:${tlsPolicy.engine}`;
  const rest = (await readParam(exec, engine, TLS_POLICY_PARAM))
    .split(/[\s,]+/)
    .filter((p) => p && p !== ours);
  if (rest.length) {
    await exec.exec(engine(`postconf -e ${sq(`${TLS_POLICY_PARAM}=${rest.join(" ")}`)}`));
  } else {
    await exec.exec(engine(`postconf -X ${TLS_POLICY_PARAM}`) + " 2>/dev/null || true");
  }
  await exec.exec(`rm -f ${tlsPolicy.write} ${tlsPolicy.write}.db`).catch(() => {});
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
  const { saslMap, tlsPolicy, engine } = await relayTransport(exec);
  const host = resolveHost(input);
  const scope: "all" | "selected" = input.scope === "selected" ? "selected" : "all";
  const nexthop = `[${host}]:${input.port}`;
  // The nexthop the previous config routed to, if it differs. Its `sender_relayhost`
  // rows must go: the SASL map only ever holds ONE relay's credentials, so a row
  // pointing at the old host would defer that sender's mail forever.
  const priorRelay = (await readState(exec))?.outboundRelay;
  const priorNexthop =
    priorRelay?.host && `[${priorRelay.host}]:${priorRelay.port}` !== nexthop
      ? `[${priorRelay.host}]:${priorRelay.port}`
      : undefined;

  // 1) Write the SASL map via SFTP (creds never touch a shell string). On the
  //    container flavor that's the host end of the bind mount; Postfix sees it at
  //    saslMap.engine.
  await exec.writeFile(saslMap.write, `${nexthop} ${input.username}:${input.password}\n`);

  // 2) Lock down + hash the map. chmod the path we wrote; `postmap` must build the
  //    .db with the Postfix that will READ it (its Berkeley-DB version), so it runs
  //    wherever the engine is.
  await exec.exec(`chmod 600 ${saslMap.write}`);
  await exec.exec(engine(`postmap ${saslMap.engine}`));
  await exec.exec(`chmod 600 ${saslMap.write}.db`).catch(() => {});

  // 3) SASL directives always; the GLOBAL relayhost only in "all" scope. In
  //    "selected" scope we clear the global relayhost so unmatched senders keep
  //    delivering direct, route the chosen ones via `sender_relayhost`, and pin
  //    relay-grade TLS per-nexthop instead of globally (see the file header).
  const sasl = [
    "smtp_sasl_auth_enable=yes",
    `smtp_sasl_password_maps=hash:${saslMap.engine}`,
    "smtp_sasl_security_options=noanonymous",
  ];

  if (scope === "all") {
    // Everything leaves via the relay, so global relay-grade TLS is safe.
    sasl.push("smtp_tls_security_level=encrypt");
    if (input.port === IMPLICIT_TLS_PORT) sasl.push("smtp_tls_wrappermode=yes");
    await exec.exec(engine(`postconf -e ${[`relayhost=${nexthop}`, ...sasl].map(sq).join(" ")}`));
    // A per-nexthop policy would be redundant, and stale if we came from "selected".
    await dropRelayTlsPolicy(exec, engine, tlsPolicy);
    // No per-sender rows for a relay we now route globally — including rows for a
    // host we just replaced, which would otherwise override the global relayhost
    // for those senders and point at credentials we no longer hold. Rows for any
    // OTHER host are left alone: we don't own them.
    await execute(
      exec,
      `DELETE FROM sender_relayhost WHERE relayhost = ${q(nexthop)}` +
        (priorNexthop ? ` OR relayhost = ${q(priorNexthop)}` : ""),
    ).catch(() => {});
  } else {
    await exec.exec(engine("postconf -X relayhost") + " 2>/dev/null || true");
    // Opportunistic globally (the engine default) so non-relayed domains still
    // reach MXes without STARTTLS; `encrypt` applies to the relay hop only.
    sasl.push("smtp_tls_security_level=may");
    const policyMaps = await pinRelayTlsPolicy(exec, engine, tlsPolicy, nexthop);
    await exec.exec(
      engine(`postconf -e ${[...sasl, `${TLS_POLICY_PARAM}=${policyMaps}`].map(sq).join(" ")}`),
    );
    // Implicit TLS is global-only and `validate` rejects :465 here, but a box that
    // previously relayed everything through :465 still has the flag set.
    await exec.exec(engine("postconf -X smtp_tls_wrappermode") + " 2>/dev/null || true");

    // Sender rows: `@domain` for whole domains, bare address for single senders.
    // Postfix's map query is most-specific-first, so both may coexist.
    const selected = relaySenderKeys({ domains: input.domains, addresses: input.addresses });
    for (const account of selected) {
      await execute(
        exec,
        `INSERT INTO sender_relayhost (account, relayhost) VALUES (${q(account)}, ${q(nexthop)}) ` +
          `ON CONFLICT (account) DO UPDATE SET relayhost = EXCLUDED.relayhost`,
      );
    }
    // Drop rows we own that are no longer selected — plus every row pointing at a
    // relay host we just replaced, whichever sender it was for.
    const notIn = selected.length ? ` AND account NOT IN (${selected.map(q).join(", ")})` : "";
    await execute(
      exec,
      `DELETE FROM sender_relayhost WHERE (relayhost = ${q(nexthop)}${notIn})` +
        (priorNexthop ? ` OR relayhost = ${q(priorNexthop)}` : ""),
    ).catch(() => {});
  }

  // 4) Reload Postfix (inside the engine).
  await exec.exec(engine("postfix reload"));

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
    // Persist the same case-folded values the `sender_relayhost` rows use, so the
    // UI's selection round-trips to exactly what Postfix will match.
    domains: scope === "selected" ? (input.domains ?? []).map((d) => d.trim().toLowerCase()) : undefined,
    addresses: scope === "selected" ? (input.addresses ?? []).map(normalizeSenderAddress) : undefined,
    spfInclude: input.spfInclude?.trim() || undefined,
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
  const { saslMap, tlsPolicy, engine } = await relayTransport(exec);

  // Remove the relay-specific directives (leave smtp_tls_security_level — it's
  // good hygiene for direct delivery too and reverting it could weaken TLS).
  await exec.exec(
    engine(
      "postconf -X relayhost smtp_sasl_auth_enable smtp_sasl_password_maps smtp_sasl_security_options smtp_tls_wrappermode",
    ) + " 2>/dev/null || true",
  );
  await exec.exec(`rm -f ${saslMap.write} ${saslMap.write}.db`);
  // The per-nexthop `encrypt` policy only made sense while the relay existed; a
  // leftover entry would pin TLS for a destination we no longer send to.
  await dropRelayTlsPolicy(exec, engine, tlsPolicy);

  // Delete the per-sender rows we own for this relay host (no `active` column —
  // presence = active, so disable must DELETE rather than deactivate).
  const pre = await readState(exec);
  const relay = pre?.outboundRelay;
  const staleInclude = relay ? relaySpfInclude(relay) : undefined;
  if (relay?.host) {
    const nexthop = `[${relay.host}]:${relay.port}`;
    await execute(exec, `DELETE FROM sender_relayhost WHERE relayhost = ${q(nexthop)}`).catch(() => {});
  }

  await exec.exec(engine("postfix reload"));

  const state = await readState(exec);
  if (!state) return null;
  return mutateState(exec, state.serverId, (s) => {
    // Revert the send-hop DNS on every domain (primary + additional). The relay's
    // own include goes with it — leaving it would keep authorizing a provider we
    // no longer send through.
    const additionalDomains = { ...(s.additionalDomains ?? {}) };
    for (const d of Object.keys(additionalDomains)) {
      const entry = additionalDomains[d];
      if (!entry) continue;
      const reverted = revertRelayDnsForDomain(entry.records as unknown as PatchableRecords, staleInclude);
      additionalDomains[d] = { ...entry, records: reverted as unknown as typeof entry.records };
    }
    const next = {
      ...s,
      dnsRecords: (revertRelayDnsForDomain(s.dnsRecords as PatchableRecords | null, staleInclude) ??
        null) as MailServerState["dnsRecords"],
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
