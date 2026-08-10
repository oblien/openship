/**
 * Mail admin API client - domain / mailbox / alias CRUD against the
 * vmail schema on the provisioned mail server.
 *
 * One namespace per entity (domains, mailboxes). Each call returns a typed
 * DTO that mirrors the backend's `apps/api/src/modules/mail/admin/*.service`
 * row shapes. The /emails admin tabs consume these directly.
 */

import { api } from "./client";
import { endpoints } from "./endpoints";
import type { DnsRecords, DnsRecord } from "./mail";
import type { BackupRun } from "./backups";

// ─── Mail backup (plugs into the general backup system) ──────────────────────

/** A mail-server backup policy. Source columns (projectId/serviceId) are
 *  null; `mailServerId` + `payloadConfig.mail` flags identify it. */
export interface MailBackupPolicy {
  id: string;
  destinationId: string;
  enabled: boolean;
  cronExpression: string | null;
  retainCount: number | null;
  retainDays: number | null;
  payloadKind: string;
  payloadConfig: {
    mail?: { messageData?: boolean; keys?: boolean };
  } & Record<string, unknown>;
}

export interface SaveMailBackupPolicyInput {
  destinationId: string;
  messageData?: boolean;
  keys?: boolean;
  cronExpression?: string | null;
  retainCount?: number | null;
  retainDays?: number | null;
}

// ─── Domains ─────────────────────────────────────────────────────────────────

export interface AdminDomain {
  domain: string;
  description: string;
  /** Current count of active mailboxes for this domain. */
  mailboxes: number;
  /** Current count of active aliases. */
  aliases: number;
  /** Domain-wide cap (0 = unlimited). The upstream schema conflates "count" and "max"
   *  on the same columns; both keys point at the same data so callers can
   *  pick the more intentional one. */
  maxMailboxes: number;
  maxAliases: number;
  /** Default per-mailbox quota cap in MB (0 = unlimited). */
  defaultQuotaMB: number;
  active: boolean;
  createdAt: string;
}

export interface CreateDomainPayload {
  domain: string;
  description?: string;
  maxMailboxes?: number;
  maxAliases?: number;
  defaultQuotaMB?: number;
}

export interface UpdateDomainPayload {
  description?: string;
  maxMailboxes?: number;
  maxAliases?: number;
  defaultQuotaMB?: number;
  active?: boolean;
}

export interface DomainDependents {
  mailboxes: number;
  aliases: number;
}

/**
 * DNS provisioning state for an additional domain (one added via the
 * Domains tab after the primary install). The dashboard renders a
 * "publish these records" banner above the table for every domain
 * where `acknowledgedAt == null`.
 *
 * Records are MX/SPF/DKIM/DMARC. Host records (A/AAAA) belong to the
 * mail subdomain on the primary install, not to additional domains.
 */
export interface AdditionalDomainDnsState {
  domain: string;
  records: {
    mx: DnsRecord;
    spf: DnsRecord;
    dkim: DnsRecord;
    dmarc: DnsRecord;
  };
  acknowledgedAt: string | null;
  createdAt: string;
}

// ─── Mailboxes ───────────────────────────────────────────────────────────────

export interface AdminMailbox {
  username: string;
  name: string;
  domain: string;
  /** In megabytes - UI converts to GB for display. 0 = unlimited. */
  quotaMB: number;
  storagebasedirectory: string;
  storagenode: string;
  maildir: string;
  active: boolean;
  isAdmin: boolean;
  isGlobalAdmin: boolean;
  createdAt: string;
  passwordLastChange: string;
}

export interface CreateMailboxPayload {
  localPart: string;
  domain: string;
  password: string;
  name?: string;
  quotaMB?: number;
}

export interface UpdateMailboxPayload {
  name?: string;
  /** Plaintext - backend hashes via doveadm. */
  password?: string;
  quotaMB?: number;
  active?: boolean;
}

// ─── Aliases / forwards / catch-all ───────────────────────────────────────────

export interface AdminAlias {
  id: number;
  address: string;
  forwarding: string;
  domain: string;
  destDomain: string;
  /** true when `address` is the bare domain (no @) - the domain's catch-all. */
  isCatchAll: boolean;
  active: boolean;
}

export interface CreateAliasPayload {
  domain: string;
  /** Ignored when isCatchAll is true. */
  localPart?: string;
  isCatchAll: boolean;
  destination: string;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface MailServerStats {
  domains: { total: number; active: number };
  mailboxes: { total: number; active: number };
  aliases: { total: number };
  /** Aggregated bytes from vmail.used_quota. May be stale by one IMAP
   *  session - Dovecot updates the row on LOGOUT, not in real time. */
  storageBytes: number;
  messages: number;
}

// ─── DNS scan ────────────────────────────────────────────────────────────────

export type DnsCheckStatus = "pass" | "warn" | "fail" | "unknown";

export interface DnsCheck {
  key: string;
  label: string;
  description: string;
  queriedName: string;
  recordType: string;
  status: DnsCheckStatus;
  expected: string;
  actual: string;
  message: string;
}

export interface DnsScanResult {
  domain: string;
  scannedAt: number;
  checks: DnsCheck[];
}

// ─── Outbound relay ──────────────────────────────────────────────────────────

/** Per-additional-domain SES identity records (each SES domain verifies separately). */
export type RelayIdentityMap = Record<string, { mailFromDomain?: string; sesDkim?: { name: string; value: string }[] }>;

/** Masked relay status from the server (password is never returned). */
export interface OutboundRelayStatus {
  enabled: boolean;
  provider: "ses" | "custom";
  /** "all" domains via a global relayhost, or only `domains` (per-sender routing). */
  scope?: "all" | "selected";
  domains?: string[];
  region?: string;
  host: string;
  port: number;
  username: string;
  mailFromDomain?: string;
  sesDkim?: { name: string; value: string }[];
  identities?: RelayIdentityMap;
  updatedAt: string;
  hasPassword: boolean;
}

/** Enable/update payload. `password` blank on update keeps the stored one. */
export interface ConfigureRelayPayload {
  provider: "ses" | "custom";
  scope?: "all" | "selected";
  domains?: string[];
  region?: string;
  host?: string;
  port: number;
  username: string;
  password?: string;
  mailFromDomain?: string;
  sesDkim?: { name: string; value: string }[];
  identities?: RelayIdentityMap;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export const mailAdminApi = {
  domains: {
    list: (serverId: string) =>
      api.get<{ domains: AdminDomain[] }>(endpoints.mail.admin.domains(serverId)),
    get: (serverId: string, domain: string) =>
      api.get<{ domain: AdminDomain }>(endpoints.mail.admin.domain(serverId, domain)),
    create: (serverId: string, payload: CreateDomainPayload) =>
      api.post<{ domain: AdminDomain; dnsWarning?: string }>(
        endpoints.mail.admin.domains(serverId),
        payload,
      ),
    update: (serverId: string, domain: string, patch: UpdateDomainPayload) =>
      api.patch<{ domain: AdminDomain }>(
        endpoints.mail.admin.domain(serverId, domain),
        patch,
      ),
    delete: (
      serverId: string,
      domain: string,
      options: { cascade?: boolean } = {},
    ) => {
      const path = options.cascade
        ? `${endpoints.mail.admin.domain(serverId, domain)}?cascade=true`
        : endpoints.mail.admin.domain(serverId, domain);
      return api.delete<{ ok: boolean }>(path);
    },
    dependents: (serverId: string, domain: string) =>
      api.get<DomainDependents>(
        endpoints.mail.admin.domainDependents(serverId, domain),
      ),
    /**
     * Fetch per-domain DNS state. Returns 404 when no records have been
     * generated for the domain (e.g. the primary install domain - its
     * records live on /mail/status as the install-time `dnsRecords`).
     */
    getDns: (serverId: string, domain: string) =>
      api.get<AdditionalDomainDnsState>(
        endpoints.mail.admin.domainDns(serverId, domain),
      ),
    /** Operator confirmed records are published. Banner stops rendering. */
    acknowledgeDns: (serverId: string, domain: string) =>
      api.post<{ ok: boolean }>(
        endpoints.mail.admin.domainDnsAcknowledge(serverId, domain),
      ),
    /** List every additional-domain that still needs DNS published. */
    pendingDns: (serverId: string) =>
      api.get<{ pending: AdditionalDomainDnsState[] }>(
        endpoints.mail.admin.pendingDomainDns(serverId),
      ),
  },
  mailboxes: {
    list: (serverId: string, domain: string) =>
      api.get<{ mailboxes: AdminMailbox[] }>(
        `${endpoints.mail.admin.mailboxes(serverId)}?domain=${encodeURIComponent(domain)}`,
      ),
    get: (serverId: string, email: string) =>
      api.get<{ mailbox: AdminMailbox }>(
        endpoints.mail.admin.mailbox(serverId, email),
      ),
    create: (serverId: string, payload: CreateMailboxPayload) =>
      api.post<{ mailbox: AdminMailbox }>(
        endpoints.mail.admin.mailboxes(serverId),
        payload,
      ),
    update: (serverId: string, email: string, patch: UpdateMailboxPayload) =>
      api.patch<{ mailbox: AdminMailbox }>(
        endpoints.mail.admin.mailbox(serverId, email),
        patch,
      ),
    softDelete: (serverId: string, email: string) =>
      api.delete<{ ok: boolean; mode: "soft" | "hard" }>(
        endpoints.mail.admin.mailbox(serverId, email),
      ),
    hardDelete: (serverId: string, email: string) =>
      api.delete<{ ok: boolean; mode: "soft" | "hard" }>(
        `${endpoints.mail.admin.mailbox(serverId, email)}?hard=true`,
      ),
  },
  aliases: {
    list: (serverId: string, domain: string) =>
      api.get<{ aliases: AdminAlias[] }>(
        `${endpoints.mail.admin.aliases(serverId)}?domain=${encodeURIComponent(domain)}`,
      ),
    create: (serverId: string, payload: CreateAliasPayload) =>
      api.post<{ alias: AdminAlias }>(
        endpoints.mail.admin.aliases(serverId),
        payload,
      ),
    setActive: (serverId: string, id: number, active: boolean) =>
      api.patch<{ alias: AdminAlias }>(
        endpoints.mail.admin.alias(serverId, id),
        { active },
      ),
    delete: (serverId: string, id: number) =>
      api.delete<{ ok: boolean }>(endpoints.mail.admin.alias(serverId, id)),
  },
  stats: {
    get: (serverId: string) =>
      api.get<MailServerStats>(endpoints.mail.admin.stats(serverId)),
  },
  dns: {
    /**
     * Live public-DNS scan. Pass `domain` to scope the check to an
     * additional domain (MX/SPF/DKIM?/DMARC only); omit for the primary
     * install domain (full record set incl. A/AAAA/PTR).
     */
    scan: (serverId: string, domain?: string) =>
      api.get<DnsScanResult>(
        domain
          ? `${endpoints.mail.admin.dnsScan(serverId)}?domain=${encodeURIComponent(domain)}`
          : endpoints.mail.admin.dnsScan(serverId),
      ),
  },
  /** Outbound relay (split delivery — self-host inbox + SES/SMTP send). */
  relay: {
    /** Current relay config, or null when direct-to-MX (masked — no password). */
    get: (serverId: string) =>
      api.get<{ relay: OutboundRelayStatus | null }>(endpoints.mail.admin.relay(serverId)),
    /** Enable / update the relay. Leave `password` blank to keep the stored one. */
    save: (serverId: string, body: ConfigureRelayPayload) =>
      api.post<{ relay: OutboundRelayStatus | null }>(endpoints.mail.admin.relay(serverId), body),
    /** Disable the relay — revert Postfix to direct-to-MX. */
    disable: (serverId: string) =>
      api.delete<{ ok: boolean }>(endpoints.mail.admin.relay(serverId)),
  },
  backup: {
    /** The mail server's backup policy, or null if none yet. */
    getPolicy: (serverId: string) =>
      api.get<{ policy: MailBackupPolicy | null }>(
        endpoints.mail.admin.backupPolicy(serverId),
      ),
    /** Create or update the mail server's backup policy. */
    savePolicy: (serverId: string, body: SaveMailBackupPolicyInput) =>
      api.post<{ policy: MailBackupPolicy }>(
        endpoints.mail.admin.backupPolicy(serverId),
        body,
      ),
    /** This mail server's backup runs (most recent first). */
    listRuns: (serverId: string) =>
      api.get<{ runs: BackupRun[] }>(endpoints.mail.admin.backupRuns(serverId)),
  },
  testEmail: {
    /**
     * Send a welcome / verification email from `postmaster@<fromDomain>`.
     * `fromDomain` defaults to the primary install domain server-side.
     * Pass the additional domain to test sending AS a newly-added domain
     * after the operator acks its DNS records.
     */
    send: (serverId: string, to: string, fromDomain?: string) =>
      api.post<{
        to: string;
        from: string;
        messageId: string;
        smtpResponse: string;
      }>(
        endpoints.mail.admin.testEmail(serverId),
        fromDomain ? { to, fromDomain } : { to },
      ),
  },
  components: {
    action: (serverId: string, key: string, action: ComponentAction) =>
      api.post<ComponentActionResult>(
        endpoints.mail.admin.componentAction(serverId, key, action),
      ),
    logs: (serverId: string, key: string, lines?: number) => {
      const base = endpoints.mail.admin.componentLogs(serverId, key);
      const path =
        typeof lines === "number" && lines > 0
          ? `${base}?lines=${encodeURIComponent(String(lines))}`
          : base;
      return api.get<ComponentLogs>(path);
    },
    restartAll: (serverId: string) =>
      api.post<BulkRestartResult>(
        endpoints.mail.admin.componentsRestartAll(serverId),
      ),
  },
};

// ─── Component actions / logs ────────────────────────────────────────────────

export type ComponentAction = "restart" | "start" | "stop";

export interface ComponentActionResult {
  key: string;
  unit: string;
  action: ComponentAction;
  output: string;
}

export interface ComponentLogs {
  key: string;
  unit: string;
  lines: string[];
}

export interface BulkRestartResult {
  results: Array<{
    key: string;
    unit: string;
    ok: boolean;
    error?: string;
  }>;
}
