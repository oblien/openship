/**
 * Live DNS scan - answers "are the records I told the operator to publish
 * actually published, and do they match?"
 *
 * Reads the expected records from the on-server state file (the same
 * record set the install wizard emitted at the DKIM step), then resolves
 * each one against the public DNS using Node's `node:dns/promises`. Each
 * check returns one of:
 *
 *   - pass : actual matches expected (exactly, or close-enough per type)
 *   - warn : record exists but doesn't match (extra entries, wrong target,
 *            stale value), or PTR is missing (recommended, not required)
 *   - fail : record is missing entirely, or its content rejects mail (e.g.
 *            DMARC says reject + we aren't authorized)
 *   - unknown : DNS resolution failed for a reason that isn't NXDOMAIN
 *
 * No mutation - pure read. Cheap to call (one DNS round trip per check,
 * resolved in parallel). The Health tab refreshes on demand.
 */

import { Resolver } from "node:dns/promises";

/**
 * PUBLIC resolvers, not the system stub.
 *
 * This scan answers "what does the rest of the internet see?", and the system
 * resolver can't: on the mail host itself `/etc/hosts` carries the
 * `127.0.1.1 mail.<domain>` line our own hostname step writes, and glibc/
 * systemd-resolved synthesize an A record from it — so every install reported
 * "A record resolves to 127.0.1.1 instead of <public ip>" against perfectly
 * correct DNS. Querying public resolvers directly is the only way to see the
 * published zone. Two, so one being unreachable isn't a scan failure.
 */
const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];

const publicResolver = new Resolver();
publicResolver.setServers(PUBLIC_DNS_SERVERS);

const resolve4 = publicResolver.resolve4.bind(publicResolver);
const resolve6 = publicResolver.resolve6.bind(publicResolver);
const resolveCname = publicResolver.resolveCname.bind(publicResolver);
const resolveMx = publicResolver.resolveMx.bind(publicResolver);
const resolveTxt = publicResolver.resolveTxt.bind(publicResolver);
const reverse = publicResolver.reverse.bind(publicResolver);
import { sshManager } from "../../../lib/ssh-manager";
import { readState } from "../mail-state";
import { relayedDomainsFor, safeErrorMessage, mailHostname } from "@repo/core";

export type DnsCheckStatus = "pass" | "warn" | "fail" | "unknown";

export interface DnsCheck {
  key: string;
  /** Human-readable check name shown in the UI list. */
  label: string;
  /** Short description of what this check is for. */
  description: string;
  /** The DNS name we queried - useful for "actually run `dig` here". */
  queriedName: string;
  /** Record type - A / AAAA / MX / TXT / CNAME / PTR. */
  recordType: string;
  status: DnsCheckStatus;
  /** What we expected to find. Empty string for "anything". */
  expected: string;
  /** What we actually got. Empty string when missing. */
  actual: string;
  /** Operator-friendly explanation of the result. */
  message: string;
}

interface ExpectedRecord {
  type?: string;
  name?: string;
  value?: string;
  priority?: number;
  /** False = optional/recommended → a missing record warns instead of fails. */
  required?: boolean;
}

interface ExpectedRecords {
  a?: ExpectedRecord;
  aaaa?: ExpectedRecord;
  mx?: ExpectedRecord;
  spf?: ExpectedRecord;
  dkim?: ExpectedRecord;
  dmarc?: ExpectedRecord;
  /**
   * Extra records beyond the fixed set — the outbound-relay send-hop records
   * (relay DKIM CNAMEs + MAIL FROM MX/TXT). Verified with type-aware lookups.
   */
  extraRecords?: ExpectedRecord[];
}

export interface DnsScanResult {
  domain: string;
  scannedAt: number;
  checks: DnsCheck[];
}

/**
 * Run the scan for a server, optionally scoped to a specific domain.
 *
 * Pulls expected records from the on-server state file, then resolves each
 * against public DNS in parallel. Returns a flat list of checks + the
 * timestamp for the "scanned at X" UI hint.
 *
 * Domain scoping:
 *   - omitted / primary install domain → the full record set (A/AAAA/MX/
 *     SPF/DKIM/DMARC/PTR) from `state.dnsRecords`.
 *   - an additional domain → only MX/SPF/DKIM?/DMARC from
 *     `state.additionalDomains[domain].records`. A/AAAA/PTR are skipped:
 *     those test the shared `mail.<installDomain>` host, which the primary
 *     scan already covers, and additional domains never carry them.
 */
export async function scanDns(serverId: string, domain?: string): Promise<DnsScanResult> {
  const state = await sshManager.withExecutor(serverId, (exec) => readState(exec));
  if (!state || !state.domain) {
    return { domain: "", scannedAt: Date.now(), checks: [] };
  }

  const target = domain?.trim().toLowerCase() || state.domain;
  const isPrimary = target === state.domain;
  const relay = state.outboundRelay?.enabled ? state.outboundRelay : undefined;
  // Scope `all` is the only config with no direct outbound path left — see checkPtr.
  const relayedAll = relay !== undefined && relay.scope !== "selected";
  // Does THIS domain send through the smarthost? Same rule `applyRelayToState` uses
  // to decide which domains get relay records, read from @repo/core so the scan
  // can't disagree with what we published.
  const relayed =
    relayedAll ||
    (relay !== undefined &&
      relayedDomainsFor({ domains: relay.domains, addresses: relay.addresses }).includes(target));

  if (isPrimary) {
    if (!state.dnsRecords) {
      return { domain: "", scannedAt: Date.now(), checks: [] };
    }
    const expected = state.dnsRecords as unknown as ExpectedRecords;
    const checks = await Promise.all([
      checkA(target, expected.a),
      checkAaaa(target, expected.aaaa),
      checkMx(target, expected.mx),
      checkSpf(target, expected.spf, relayed),
      checkDkim(target, expected.dkim),
      checkDmarc(target, expected.dmarc),
      checkPtr(expected.a, target, relayedAll),
      // Outbound-relay send-hop records (relay DKIM CNAMEs + MAIL FROM), if any.
      ...(expected.extraRecords ?? []).map((r, i) => checkExtra(r, i)),
    ]);
    return {
      domain: target,
      scannedAt: Date.now(),
      checks: checks.filter((c): c is DnsCheck => c !== null),
    };
  }

  // Additional domain: MX/SPF/DKIM?/DMARC only.
  const additional = state.additionalDomains?.[target]?.records;
  if (!additional) {
    return { domain: target, scannedAt: Date.now(), checks: [] };
  }
  const expected = additional as unknown as ExpectedRecords;
  const checks = await Promise.all([
    checkMx(target, expected.mx),
    checkSpf(target, expected.spf, relayed),
    checkDkim(target, expected.dkim),
    checkDmarc(target, expected.dmarc),
    // Outbound-relay send-hop records (relay DKIM CNAMEs + MAIL FROM) when this
    // domain routes through the relay — mirrors the primary-domain branch.
    ...(expected.extraRecords ?? []).map((r, i) => checkExtra(r, i)),
  ]);
  return {
    domain: target,
    scannedAt: Date.now(),
    checks: checks.filter((c): c is DnsCheck => c !== null),
  };
}

/**
 * Addresses that mean "a local interceptor answered", not "this is where the name
 * points" (GH-240 FP2).
 *
 * Pinning the resolver to 1.1.1.1/8.8.8.8 is not enough on a machine behind a
 * fake-IP proxy: Clash, sing-box and friends run a TUN that captures UDP:53 to ANY
 * destination and synthesise an address per hostname, so the query never leaves the box
 * and the answer is an internal handle. Compared against the real public IP that reads as
 * "resolves, but to 198.18.x.x" — the operator is told their DNS is wrong when their DNS
 * is fine and only the machine running the scan cannot see it.
 *
 *   198.18.0.0/15  RFC 2544 benchmarking range - the documented default fake-ip-range
 *                  for Clash and sing-box, and never legitimately a public mail host.
 *   240.0.0.0/4    RFC 1112 reserved (class E); used by some fake-IP configs.
 *   fc00::/7       IPv6 ULA, which covers sing-box's fd00::/18 v6 default.
 *
 * A real A record can never legitimately be any of these, so treating them as
 * "unverifiable" costs nothing and stops the scan lying about the zone.
 */
export function looksSyntheticAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const head = parseInt(ip.split(":")[0] || "0", 16);
    return head >= 0xfc00 && head <= 0xfdff;
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 240) return true;
  return false;
}

// ─── Per-record checks ───────────────────────────────────────────────────────

async function checkA(domain: string, exp?: ExpectedRecord): Promise<DnsCheck | null> {
  if (!exp?.value) return null;
  const name = exp.name || mailHostname(domain);
  try {
    const ips = await resolve4(name);
    const match = ips.includes(exp.value);
    // A synthetic answer says nothing about the published zone, so report "we could not
    // look" rather than "your record is wrong".
    if (!match && ips.length > 0 && ips.every(looksSyntheticAddress)) {
      return {
        key: "a",
        label: "A record",
        description: `Points the mail server hostname (${name}) at the VPS public IP.`,
        queriedName: name,
        recordType: "A",
        status: "unknown",
        expected: exp.value,
        actual: ips.join(", "),
        message:
          `DNS could not be verified from here: ${name} resolved to ${ips.join(", ")}, ` +
          `which is a synthetic address from a local DNS interceptor (a fake-IP VPN or ` +
          `proxy such as Clash or sing-box), not a published record. Re-run the scan with ` +
          `that proxy off, or check the record from another network.`,
      };
    }
    return {
      key: "a",
      label: "A record",
      description: `Points the mail server hostname (${name}) at the VPS public IP.`,
      queriedName: name,
      recordType: "A",
      status: match ? "pass" : ips.length > 0 ? "warn" : "fail",
      expected: exp.value,
      actual: ips.join(", "),
      message: match
        ? "A record matches the mail server's public IP."
        : ips.length > 0
          ? `A record resolves, but to ${ips.join(", ")} instead of ${exp.value}.`
          : "A record exists but no IPv4 addresses returned.",
    };
  } catch (err) {
    return missing("a", "A record", name, "A", exp.value, err);
  }
}

async function checkAaaa(domain: string, exp?: ExpectedRecord): Promise<DnsCheck | null> {
  if (!exp?.value) return null;
  const name = exp.name || mailHostname(domain);
  try {
    const ips = await resolve6(name);
    const match = ips.some((ip) => normaliseIpv6(ip) === normaliseIpv6(exp.value!));
    return {
      key: "aaaa",
      label: "AAAA record",
      description: "IPv6 address for the mail hostname. Recommended for delivery to Gmail.",
      queriedName: name,
      recordType: "AAAA",
      status: match ? "pass" : "warn",
      expected: exp.value,
      actual: ips.join(", "),
      message: match
        ? "AAAA record matches the server's IPv6 address."
        : `AAAA returned ${ips.join(", ")} which doesn't match ${exp.value}.`,
    };
  } catch (err) {
    // AAAA is recommended, not required → warn on NXDOMAIN.
    if (isNotFound(err)) {
      return {
        key: "aaaa",
        label: "AAAA record",
        description: "IPv6 address for the mail hostname. Recommended for delivery to Gmail.",
        queriedName: name,
        recordType: "AAAA",
        status: "warn",
        expected: exp.value,
        actual: "",
        message:
          "AAAA record not published. IPv6 delivery to Gmail is more reliable when this exists, but it's not required.",
      };
    }
    return missing("aaaa", "AAAA record", name, "AAAA", exp.value, err);
  }
}

async function checkMx(domain: string, exp?: ExpectedRecord): Promise<DnsCheck | null> {
  if (!exp?.value) return null;
  try {
    const mxs = await resolveMx(domain);
    if (mxs.length === 0) {
      return {
        key: "mx",
        label: "MX record",
        description: "Tells the world where to deliver mail for this domain.",
        queriedName: domain,
        recordType: "MX",
        status: "fail",
        expected: `${exp.value} (priority ${exp.priority ?? 10})`,
        actual: "",
        message: "No MX record found. Mail can't be delivered to this domain.",
      };
    }
    const wanted = trimDot(exp.value);
    const match = mxs.some((m) => trimDot(m.exchange) === wanted);
    return {
      key: "mx",
      label: "MX record",
      description: "Tells the world where to deliver mail for this domain.",
      queriedName: domain,
      recordType: "MX",
      status: match ? "pass" : "warn",
      expected: wanted,
      actual: mxs.map((m) => `${trimDot(m.exchange)} (priority ${m.priority})`).join(", "),
      message: match
        ? "MX record points at the mail server."
        : `MX records exist but none point at ${wanted}. Mail will be delivered elsewhere.`,
    };
  } catch (err) {
    return missing("mx", "MX record", domain, "MX", exp.value, err);
  }
}

/**
 * SPF mechanisms in `actual` that can authorise a THIRD-PARTY sender and that we
 * didn't ask for — an operator's own `ip4:` for their smarthost, an `include:` they
 * pasted by hand. Bare `a` / `mx` / `ptr` don't count: they resolve to the domain's
 * own hosts, which is never the relay.
 */
function foreignSenderMechanisms(actual: string, expected: string): string[] {
  const want = expected.toLowerCase();
  return [
    ...actual.toLowerCase().matchAll(/(?:ip4:|ip6:|include:|exists:|a:|redirect=)\S+/g),
  ]
    .map((m) => m[0])
    .filter((m) => !want.includes(m));
}

/**
 * `relayed` = this domain's outbound goes through the smarthost, which changes what
 * a correct SPF record even looks like: the connection the receiver checks comes
 * from the PROVIDER's IPs, so `mx` and our `ip4:` no longer cover it.
 */
async function checkSpf(
  domain: string,
  exp?: ExpectedRecord,
  relayed = false,
): Promise<DnsCheck | null> {
  if (!exp?.value) return null;
  try {
    const txt = (await resolveTxt(domain)).map((parts) => parts.join(""));
    const spfRecords = txt.filter((t) => /^v=spf1\b/i.test(t));
    const spf = spfRecords[0];
    if (!spf) {
      return {
        key: "spf",
        label: "SPF record",
        description: "Lets receivers verify this server is authorised to send for the domain.",
        queriedName: domain,
        recordType: "TXT",
        status: "fail",
        expected: exp.value,
        actual: "",
        message:
          "No SPF record found. Outbound mail will be marked as suspicious by most receivers.",
      };
    }
    if (spfRecords.length > 1) {
      return {
        key: "spf",
        label: "SPF record",
        description: "Lets receivers verify this server is authorised to send for the domain.",
        queriedName: domain,
        recordType: "TXT",
        status: "fail",
        expected: exp.value,
        actual: spfRecords.join(" | "),
        message:
          "Multiple SPF records found. A domain must publish exactly one v=spf1 TXT record or receivers treat SPF as invalid.",
      };
    }
    // We can't do a strict equality - operators sometimes add their own
    // ip4: / include: entries. So we check the two mechanisms we generated,
    // independently. When an outbound relay is on, the expected value also
    // carries the provider's `include:` — read from the expected value rather
    // than naming a provider, so this works for any relay in the registry (and
    // for an operator's own include).
    //
    // A relay include does NOT retire `mx`: the server still delivers direct for
    // every sender the relay isn't scoped to (and in `selected` scope that's most
    // of them), and `mx` is what authorises those. So both are required, at
    // different severities — a missing include means relayed mail hard-fails SPF
    // right now, while a missing `mx` only costs the senders still going direct.
    const containsMx = /\bmx\b/i.test(spf);
    const wantIncludes = [...exp.value.matchAll(/include:[A-Za-z0-9._-]+/gi)].map((m) => m[0].toLowerCase());
    const missingIncludes = wantIncludes.filter((inc) => !spf.toLowerCase().includes(inc));
    // The one way this check could go green on mail that fails SPF every single
    // time: a relayed domain for which we published NO include at all, because the
    // provider's token is account- or region-specific (Resend, Oracle) or it's a
    // `custom` smarthost. Then nothing in the record covers the host that actually
    // connects to the receiver — unless the operator authorised it themselves with a
    // mechanism we never generated, in which case we stay quiet rather than nag a
    // working setup we can't fully verify.
    const unauthorisedRelay =
      relayed && wantIncludes.length === 0 && foreignSenderMechanisms(spf, exp.value).length === 0;
    const status: DnsCheckStatus =
      missingIncludes.length || unauthorisedRelay ? "fail" : containsMx ? "pass" : "warn";
    return {
      key: "spf",
      label: "SPF record",
      description: "Lets receivers verify this server is authorised to send for the domain.",
      queriedName: domain,
      recordType: "TXT",
      status,
      expected: exp.value,
      actual: spf,
      message: missingIncludes.length
        ? `SPF record is missing \`${missingIncludes.join("`, `")}\`. Mail relayed through your provider fails SPF until you add it.`
        : unauthorisedRelay
          ? "This domain sends through your relay, but its SPF record only authorises this server - so every relayed message fails SPF. Add your provider's SPF include in the Sending tab and re-publish."
          : containsMx
            ? wantIncludes.length
              ? `SPF record authorises this server and the relay (${wantIncludes.join(", ")}).`
              : "SPF record exists and authorises the MX (this server)."
            : wantIncludes.length
              ? "SPF record authorises the relay but no longer includes `mx`. Anything this server sends directly will fail SPF."
              : "SPF record exists but doesn't include `mx`. Mail from this server may fail SPF.",
    };
  } catch (err) {
    return missing("spf", "SPF record", domain, "TXT", exp.value, err);
  }
}

async function checkDkim(domain: string, exp?: ExpectedRecord): Promise<DnsCheck | null> {
  if (!exp?.value) return null;
  const name = exp.name || `dkim._domainkey.${domain}`;
  try {
    const txt = (await resolveTxt(name)).map((parts) => parts.join(""));
    if (txt.length === 0) {
      return {
        key: "dkim",
        label: "DKIM key",
        description: "Public key receivers use to verify message signatures.",
        queriedName: name,
        recordType: "TXT",
        status: "fail",
        expected: exp.value.slice(0, 64) + "…",
        actual: "",
        message: "No DKIM TXT record found. Outgoing mail won't be signed.",
      };
    }
    const wantedStripped = exp.value.replace(/\s+/g, "");
    // A 2048-bit key is ~400 chars, past the 255-byte cap on a single DNS
    // string, so the record is ALWAYS chunked. Node normally returns those
    // chunks as one record (`[[a, b]]`, joined above), but some resolvers —
    // Docker's embedded DNS among them — hand each chunk back as a separate
    // record. Comparing entry-by-entry then matches neither half and reports a
    // mismatch against a byte-identical published key. Concatenating in order
    // covers that shape; the per-entry check still handles the normal one.
    const matched =
      txt.some((t) => t.replace(/\s+/g, "") === wantedStripped) ||
      txt.join("").replace(/\s+/g, "") === wantedStripped;
    return {
      key: "dkim",
      label: "DKIM key",
      description: "Public key receivers use to verify message signatures.",
      queriedName: name,
      recordType: "TXT",
      status: matched ? "pass" : "warn",
      expected: exp.value.slice(0, 64) + "…",
      actual: txt[0].slice(0, 64) + "…",
      message: matched
        ? "DKIM TXT matches the key this server signs with."
        : "DKIM TXT exists but doesn't match the key generated at install. Rotate it or update the published record.",
    };
  } catch (err) {
    return missing("dkim", "DKIM key", name, "TXT", exp.value.slice(0, 64) + "…", err);
  }
}

// DMARC Policy Record identification, per RFC 9989 sections 4.7/4.8/4.10:
// the record must start with the version tag (no leading WSP), the tag name
// is case-insensitive while the value is case-sensitively "DMARC1", WSP
// (space/tab) may surround "=", and the tag must end at ";", WSP, or end of
// record. So "v=dmarc1" is ignored outright and "v=DMARC10" is not a policy
// record for this version of DMARC.
const DMARC_VERSION_TAG = /^[vV][ \t]*=[ \t]*DMARC1(?:[ \t;]|$)/;

async function checkDmarc(domain: string, exp?: ExpectedRecord): Promise<DnsCheck | null> {
  if (!exp?.value) return null;
  const name = exp.name || `_dmarc.${domain}`;
  try {
    const txt = (await resolveTxt(name)).map((parts) => parts.join(""));
    const dmarcRecords = txt.filter((t) => DMARC_VERSION_TAG.test(t));
    const dmarc = dmarcRecords[0];
    if (!dmarc) {
      return {
        key: "dmarc",
        label: "DMARC policy",
        description: "Tells receivers what to do when SPF/DKIM fail for this domain.",
        queriedName: name,
        recordType: "TXT",
        status: "fail",
        expected: exp.value,
        actual: "",
        message: "No DMARC record found. Some receivers will treat this as a risk signal.",
      };
    }
    if (dmarcRecords.length > 1) {
      return {
        key: "dmarc",
        label: "DMARC policy",
        description: "Tells receivers what to do when SPF/DKIM fail for this domain.",
        queriedName: name,
        recordType: "TXT",
        status: "fail",
        expected: exp.value,
        actual: dmarcRecords.join(" | "),
        message:
          "Multiple DMARC records found. Receivers discard every DMARC record at this name, so none of them apply. Publish exactly one v=DMARC1 TXT record at this name.",
      };
    }
    return {
      key: "dmarc",
      label: "DMARC policy",
      description: "Tells receivers what to do when SPF/DKIM fail for this domain.",
      queriedName: name,
      recordType: "TXT",
      status: "pass",
      expected: exp.value,
      actual: dmarc,
      message: "DMARC policy is published.",
    };
  } catch (err) {
    return missing("dmarc", "DMARC policy", name, "TXT", exp.value, err);
  }
}

/**
 * PTR (reverse DNS) for the mail host's IP.
 *
 * `relayedAll` = every outbound message leaves through the smarthost (relay scope
 * `all`), so no receiver ever opens a connection FROM this IP and its PTR cannot
 * cost a delivery. Missing PTR then warns instead of failing: this is the exact
 * box the relay exists to rescue — blocklisted IP, blocked :25, no rDNS control on
 * a container host — and painting the thing the operator deliberately routed
 * around red is a false alarm that buries the rows that do matter. Scope
 * `selected` keeps a direct path alive for every sender it doesn't cover, so PTR
 * stays required there.
 */
async function checkPtr(
  aRecord: ExpectedRecord | undefined,
  domain: string,
  relayedAll = false,
): Promise<DnsCheck | null> {
  if (!aRecord?.value) return null;
  const expectedHost = trimDot(mailHostname(domain));
  const base = {
    key: "ptr",
    label: "PTR (reverse DNS)",
    description: relayedAll
      ? "Set at your VPS provider - NOT your DNS provider. Only affects mail this server sends directly; yours goes through the relay."
      : "Set at your VPS provider - NOT your DNS provider. Required by Gmail/Outlook for mail acceptance.",
    queriedName: aRecord.value,
    recordType: "PTR",
    expected: expectedHost,
  };
  const missStatus: DnsCheckStatus = relayedAll ? "warn" : "fail";
  const missMessage = relayedAll
    ? "No PTR record set. Outbound mail goes through your relay, so nothing is blocked today - set it before switching back to direct sending."
    : "No PTR record set. Gmail and Outlook will mark your outbound mail as spam or reject it.";
  try {
    const names = await reverse(aRecord.value);
    if (names.length === 0) {
      return { ...base, status: missStatus, actual: "", message: missMessage };
    }
    const matched = names.some((n) => trimDot(n) === expectedHost);
    return {
      ...base,
      status: matched ? "pass" : "warn",
      actual: names.join(", "),
      message: matched
        ? "PTR matches the mail hostname."
        : relayedAll
          ? `PTR resolves to ${names.join(", ")} instead of ${expectedHost}. Harmless while outbound goes through your relay.`
          : `PTR resolves to ${names.join(", ")} instead of ${expectedHost}. Gmail/Outlook may still reject your mail.`,
    };
  } catch (err) {
    if (isNotFound(err)) {
      return {
        ...base,
        status: missStatus,
        actual: "",
        message: relayedAll ? missMessage : "No PTR record set. Configure it at your VPS provider's panel.",
      };
    }
    return missing("ptr", "PTR (reverse DNS)", aRecord.value, "PTR", expectedHost, err);
  }
}

/**
 * Verify one "extra" send-hop record (relay DKIM CNAME, or MAIL FROM MX/TXT).
 * Type-aware: CNAME → resolveCname, MX → resolveMx, TXT → resolveTxt. A record
 * flagged `required:false` (MAIL FROM) warns rather than fails when missing.
 */
async function checkExtra(exp: ExpectedRecord, idx: number): Promise<DnsCheck | null> {
  if (!exp.value || !exp.name || !exp.type) return null;
  const type = exp.type.toUpperCase();
  const key = `extra:${type.toLowerCase()}:${idx}`;
  const missStatus: DnsCheckStatus = exp.required === false ? "warn" : "fail";
  const isDkim = type === "CNAME";
  const label = isDkim ? "Relay DKIM (CNAME)" : type === "MX" ? "MAIL FROM (MX)" : "MAIL FROM (TXT)";
  const description = isDkim
    ? `Delegates DKIM signing for the relay send-hop (${exp.name}).`
    : `Custom MAIL FROM record for relay SPF/bounce alignment (${exp.name}).`;
  try {
    if (type === "CNAME") {
      const targets = await resolveCname(exp.name);
      const wanted = trimDot(exp.value).toLowerCase();
      const matched = targets.some((tt) => trimDot(tt).toLowerCase() === wanted);
      return {
        key, label, description, queriedName: exp.name, recordType: "CNAME",
        status: matched ? "pass" : targets.length ? "warn" : missStatus,
        expected: wanted,
        actual: targets.join(", "),
        message: matched
          ? "CNAME points at the provider's DKIM target."
          : targets.length
            ? `CNAME resolves to ${targets.join(", ")} instead of ${wanted}.`
            : "CNAME not published yet.",
      };
    }
    if (type === "MX") {
      const mxs = await resolveMx(exp.name);
      const wanted = trimDot(exp.value).toLowerCase();
      const matched = mxs.some((m) => trimDot(m.exchange).toLowerCase() === wanted);
      return {
        key, label, description, queriedName: exp.name, recordType: "MX",
        status: matched ? "pass" : mxs.length ? "warn" : missStatus,
        expected: wanted,
        actual: mxs.map((m) => trimDot(m.exchange)).join(", "),
        message: matched
          ? "MAIL FROM MX is published."
          : mxs.length
            ? "An MX exists but doesn't match the provider's feedback host."
            : "MAIL FROM MX not published (recommended for alignment).",
      };
    }
    // TXT (MAIL FROM SPF).
    const txt = (await resolveTxt(exp.name)).map((parts) => parts.join(""));
    const wanted = exp.value.replace(/\s+/g, "");
    // Lenient second pass: any v=spf1 record carrying the include we expect is
    // good enough (operators reorder mechanisms). Provider-agnostic — the token
    // comes from the expected value, not a hardcoded provider.
    const wantedIncludes = [...exp.value.matchAll(/include:[A-Za-z0-9._-]+/gi)].map((m) => m[0].toLowerCase());
    const matched =
      txt.some((tt) => tt.replace(/\s+/g, "") === wanted) ||
      (wantedIncludes.length > 0 &&
        txt.some(
          (tt) => /^v=spf1\b/i.test(tt) && wantedIncludes.every((inc) => tt.toLowerCase().includes(inc)),
        ));
    return {
      key, label, description, queriedName: exp.name, recordType: "TXT",
      status: matched ? "pass" : txt.length ? "warn" : missStatus,
      expected: exp.value,
      actual: txt[0] ?? "",
      message: matched
        ? "MAIL FROM TXT is published."
        : txt.length
          ? "A TXT exists but doesn't match the expected MAIL FROM SPF."
          : "MAIL FROM TXT not published (recommended for alignment).",
    };
  } catch (err) {
    if (isNotFound(err)) {
      return {
        key, label, description, queriedName: exp.name, recordType: type,
        status: missStatus,
        expected: exp.value,
        actual: "",
        message: `${type} record not published yet.`,
      };
    }
    return missing(key, label, exp.name, type, exp.value, err);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function missing(
  key: string,
  label: string,
  name: string,
  type: string,
  expected: string,
  err: unknown,
): DnsCheck {
  if (isNotFound(err)) {
    return {
      key,
      label,
      description: `${type} record at ${name}.`,
      queriedName: name,
      recordType: type,
      status: "fail",
      expected,
      actual: "",
      message: `${type} record is missing. Publish it at your DNS provider.`,
    };
  }
  return {
    key,
    label,
    description: `${type} record at ${name}.`,
    queriedName: name,
    recordType: type,
    status: "unknown",
    expected,
    actual: "",
    message: `Lookup failed: ${safeErrorMessage(err)}`,
  };
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  return code === "ENOTFOUND" || code === "ENODATA";
}

function trimDot(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

function normaliseIpv6(s: string): string {
  // Lowercase + strip zone id; resolve6 already returns canonical form,
  // but operators sometimes publish with a mix of case in their DNS UI.
  return s.toLowerCase().replace(/^::/, "0:0:0:0:0:0:0:0::").replace(/%.*$/, "");
}
