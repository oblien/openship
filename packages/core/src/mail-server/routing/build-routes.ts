/**
 * Build the routing + DNS plan for one mail server.
 *
 * Pure function - no I/O, no platform calls, no DB. Takes the four inputs
 * (user domain, mail VPS IP, Zero server origin, Zero client origin, openship
 * API origin) and produces the complete plan that
 *   - `register.service.ts` feeds into openship's routing layer, and
 *   - the dashboard UI renders as the DNS-records instruction list.
 *
 * Why pure: this is the contract surface. We want it unit-testable in
 * isolation so the route topology can be verified without booting the
 * platform, and re-derivable for migrations (e.g. moving a user to a new
 * mail VPS IP - just call `buildMailServerRoutes` with the new IP and
 * diff the result against what's currently registered).
 */

import type {
  MailDnsRecord,
  MailRoute,
  MailServerRouteInput,
  MailServerRoutePlan,
} from "./types";

/**
 * Construct the route+DNS topology iRedMail's nginx used to set up locally -
 * but published into openship's routing layer instead, with the mail VPS
 * exposing only raw mail protocols.
 */
export function buildMailServerRoutes(input: MailServerRouteInput): MailServerRoutePlan {
  const normalized = normalizeInput(input);
  return {
    input: normalized,
    routes: buildRoutes(normalized),
    dns: buildDnsRecords(normalized),
  };
}

// ─── Internal: route construction ──────────────────────────────────────────

/**
 * The hostnames a mail-server install fronts, for one user domain.
 *
 * Exported so anything that needs to know "is this hostname a mail route?" reads
 * it from HERE rather than re-deriving the prefixes. The edge-orphan sweep is the
 * caller that matters: mail vhosts have no `domain` row, so without this they'd
 * be reported as untracked on every scan. Re-deriving `mail.`/`api.mail.`/
 * `autodiscover.` there would mean a prefix change silently starts flagging live
 * mail routes as orphans.
 */
export function mailServerRouteHostnames(userDomain: string): string[] {
  const d = userDomain;
  return [`mail.${d}`, `api.mail.${d}`, `autodiscover.${d}`];
}

function buildRoutes(input: MailServerRouteInput): MailRoute[] {
  const d = input.userDomain;
  const [clientHost, apiHost, autodiscoverHost] = mailServerRouteHostnames(d);
  return [
    {
      id: "mail-client",
      hostname: clientHost!,
      targetUrl: input.zeroClientOrigin,
      tls: true,
      description: "Zero web client - the user-facing webmail UI.",
    },
    {
      id: "mail-api",
      hostname: apiHost!,
      targetUrl: input.zeroServerOrigin,
      tls: true,
      description: "Zero server - tRPC API consumed by the Zero client (auth via Dovecot IMAP).",
    },
    {
      id: "autodiscover",
      hostname: autodiscoverHost!,
      targetUrl: input.openshipApiOrigin,
      tls: true,
      description: "Outlook / Thunderbird autodiscover XML - served by openship's API controller.",
    },
    // Intentionally no public "email-admin" route - mailbox / domain / alias
    // management runs inside openship's API, which writes to the mail-server
    // Postgres directly via @repo/db-email. Postfix and Dovecot see new rows
    // on their next query, no HTTP admin surface on the mail VPS at all.
  ];
}

// ─── Internal: DNS record construction ─────────────────────────────────────

function buildDnsRecords(input: MailServerRouteInput): MailDnsRecord[] {
  const d = input.userDomain;
  const apex = d;

  return [
    // ── Mail delivery (required) ────────────────────────────────────────
    {
      id: "mailservice-a",
      type: "A",
      name: `mailservice.${d}`,
      value: input.mailServerIp,
      description: `Points to the mail VPS itself. The MX record (next row) references this host so external mail servers know where to deliver mail for ${apex}.`,
      required: true,
    },
    {
      id: "apex-mx",
      type: "MX",
      name: apex,
      value: `mailservice.${d}.`,
      priority: 10,
      description: `Tells the world: mail for any @${apex} address should be delivered to mailservice.${d}.`,
      required: true,
    },

    // ── Deliverability - strongly recommended ───────────────────────────
    {
      id: "spf",
      type: "TXT",
      name: apex,
      // mx → trust whatever IP serves the MX record (mailservice.<domain>)
      // -all → reject mail from any other source claiming to be from this domain
      value: "v=spf1 mx -all",
      description: `SPF: only the IP behind mailservice.${d} is authorized to send mail from @${apex}. Without this, your mail will be marked spam by Gmail/Outlook.`,
      required: false,
    },
    {
      id: "dkim",
      type: "TXT",
      name: `dkim._domainkey.${d}`,
      // Filled in after iRedMail finishes installing - Amavisd generates the
      // DKIM keypair during setup. The dashboard surfaces the actual key
      // once the install completes.
      value: "<DKIM public key - generated during mail server install; copy from openship dashboard once provisioning completes>",
      description: `DKIM signs outgoing mail with a private key the mail server holds; recipients verify against this public key. Critical for deliverability to Gmail/Outlook.`,
      required: false,
    },
    {
      id: "dmarc",
      type: "TXT",
      name: `_dmarc.${d}`,
      // p=quarantine is a sensible default: failing mail goes to spam, not
      // outright rejected. Users can tighten to p=reject later.
      value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${apex}`,
      description: `DMARC: tells recipient servers what to do if SPF + DKIM fail (quarantine = send to spam). Reports of failures get mailed to dmarc@${apex}.`,
      required: false,
    },

    // ── Web routes pointed at openship's routing ingress ────────────────
    //
    // These are CNAMEs (or A records - depends on the user's DNS provider)
    // from the user-facing hostnames to wherever openship's routing layer
    // ingress lives. We emit CNAMEs because the routing-layer ingress
    // hostname is what openship knows; the resolved IP is openship's
    // problem (and can change without re-pointing DNS).
    //
    // The `value` here uses the routing layer's hostname - extracted from
    // the originally-provided targetUrl. Users using A-record-only DNS
    // (legacy) can be told to resolve this CNAME to its A record manually.
    {
      id: "mail-client-cname",
      type: "CNAME",
      name: `mail.${d}`,
      value: hostnameFromUrl(input.zeroClientOrigin),
      description: `Routes mail.${d} (the webmail UI) to openship's app-deploy ingress where the Zero client is hosted.`,
      required: true,
    },
    {
      id: "mail-api-cname",
      type: "CNAME",
      name: `api.mail.${d}`,
      value: hostnameFromUrl(input.zeroServerOrigin),
      description: `Routes api.mail.${d} (the Zero server's tRPC API) to the mail VPS via openship's routing layer.`,
      required: true,
    },
    // No email-admin CNAME - admin operations run inside openship's own API
    // and write to the mail-server Postgres directly. There is no public
    // admin endpoint to point at.
    {
      id: "autodiscover-cname",
      type: "CNAME",
      name: `autodiscover.${d}`,
      value: hostnameFromUrl(input.openshipApiOrigin),
      description: `Routes autodiscover.${d} to openship's API, which serves the XML mail clients use to auto-configure (Outlook, Thunderbird).`,
      required: false,
    },
  ];
}

// ─── Internal: helpers ─────────────────────────────────────────────────────

function normalizeInput(input: MailServerRouteInput): MailServerRouteInput {
  return {
    userDomain: input.userDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, ""),
    mailServerIp: input.mailServerIp.trim(),
    zeroServerOrigin: input.zeroServerOrigin.trim(),
    zeroClientOrigin: input.zeroClientOrigin.trim(),
    openshipApiOrigin: input.openshipApiOrigin.trim(),
  };
}

/**
 * Extract a bare hostname from a URL or host:port string.
 * Used to convert proxy targets (which may include a scheme + port) into
 * the bare hostname suitable for a CNAME record value.
 *
 *   "https://api.opsh.io:443"  → "api.opsh.io"
 *   "10.0.5.12:3001"           → "10.0.5.12"  (won't work as CNAME, but
 *                                              caller's responsibility - they
 *                                              should supply a hostname not an IP)
 *   "api.opsh.io"              → "api.opsh.io"
 */
function hostnameFromUrl(value: string): string {
  // Strip scheme if present.
  const noScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // Strip path.
  const noPath = noScheme.split("/", 1)[0]!;
  // Strip port.
  const noPort = noPath.split(":", 1)[0]!;
  return noPort;
}
