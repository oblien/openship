import type { RelayProviderId } from "@repo/core";
import { api, ApiError, getApiBaseUrl, getActiveOrganizationId, getApiErrorCode } from "./client";
import { endpoints } from "./endpoints";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MailSetupStep {
  id: number;
  key: string;
  label: string;
  description: string;
}

export interface MailStepStatus extends MailSetupStep {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  message?: string;
  warning?: string;
  data?: Record<string, unknown>;
}

export interface MailSessionLogLine {
  stepId: number;
  level: "info" | "warn" | "error";
  message: string;
  ts: number;
}

// ─── Health-check types ──────────────────────────────────────────────────────

export type MailComponentStatus =
  | "active"
  | "inactive"
  | "failed"
  | "activating"
  | "deactivating"
  | "missing"
  | "unknown";

/**
 * Whether a mail server stops being one without this daemon. Server-decided (the
 * catalog in mail-health.service.ts) — never re-derived here from a key list, which
 * would be a second definition free to drift from the install gate's.
 *
 * `informational` is reported but never graded: nothing on the stack consults it, so
 * letting its state colour the banner produced an amber that was always wrong (GH-240 —
 * spamd, while amavis scores spam in-process). Keep this union in step with the server's.
 */
export type MailComponentSeverity = "required" | "advisory" | "informational";

export interface MailComponentHealth {
  key: string;
  label: string;
  description: string;
  unit: string;
  severity: MailComponentSeverity;
  status: MailComponentStatus;
  /**
   * The supervisor's state word, lower-cased. `status: "failed"` covers both
   * supervisord FATAL (given up) and BACKOFF (still retrying); this separates them.
   */
  subState?: string;
  activeSince?: string;
  /** Why the status is `unknown` — the probe's own output. */
  detail?: string;
}

export interface MailComponentDef {
  key: string;
  label: string;
  description: string;
  unit: string;
  severity: MailComponentSeverity;
}

/** How outbound mail leaves the box. */
export type MailOutboundMode = "direct" | "relay";

export type MailDeliveryStatus = "ok" | "warn" | "fail" | "unknown";

/** What a deferral reason is diagnostic OF — decides which remedy we name. */
export type MailDeferralKind = "auth" | "tls" | "network" | "rejected" | "other";

export interface MailDeferral {
  kind: MailDeferralKind;
  /** Queued messages carrying this reason, within the window the probe read. */
  count: number;
  /** The remote's own refusal text. Server-generated — never a translation key. */
  reason: string;
}

/**
 * Whether mail is actually LEAVING the server — the half the daemon rows can't
 * see. Nine running daemons say nothing about whether Postfix can hand a message
 * to the next hop, and with a relay in the path the send hop happens after our own
 * `250 OK`, so a wrong SASL password looks identical to a healthy box until you
 * read the queue.
 */
export interface MailDeliveryHealth {
  status: MailDeliveryStatus;
  mode: MailOutboundMode;
  /** The smarthost as `host:port`, when relaying. */
  relayHost?: string;
  relayScope?: "all" | "selected";
  /** Domains whose senders relay — only meaningful under `selected` scope. */
  relayDomains?: string[];
  /** Messages in the queue, from postqueue's own total (never a sampled count). */
  queued: number;
  /** The queue was larger than the window we read, so `deferrals` is a sample. */
  sampled: boolean;
  deferrals: MailDeferral[];
  /** Why the status is `unknown` — the probe's own words. */
  detail?: string;
}

export type MailPortReachabilityStatus =
  | "reachable"
  | "blocked"
  | "not_listening"
  | "not_exposed"
  | "unknown";

export interface MailPortReachabilityCheck {
  key: "smtp" | "smtps" | "submission" | "imaps";
  port: number;
  label: string;
  status: MailPortReachabilityStatus;
  listening: boolean | null;
  exposed: boolean | null;
  reachable: boolean | null;
  failure?: "timeout" | "refused" | "unresolved" | "no_route" | "error";
  detail?: string;
}

export interface MailPortReachability {
  hostname: string;
  address: string | null;
  checkedAt: number;
  status: "ok" | "fail" | "unknown";
  ports: MailPortReachabilityCheck[];
  detail?: string;
}

export interface MailHealthResponse {
  serverId: string;
  components: MailComponentHealth[];
  definitions: MailComponentDef[];
  delivery: MailDeliveryHealth;
  reachability: MailPortReachability | null;
}

/**
 * Postmaster identity + IMAP/SMTP host info. The password is never sent
 * to the client - it lives only as a hash in vmail.mailbox. Operators set
 * a known password via the Change flow when they need one.
 */
export interface MailCredentials {
  username: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

/**
 * Webmail (Zero) install record, derived entirely from the webmail PROJECT the
 * mail server is linked to — not from a state file on the box, so it survives an
 * unreachable server and reads correctly mid-build. `installed=true` means that
 * project's active deployment is ready; absent or `installed=false` means the
 * overview tab should show the Deploy CTA instead of an Open webmail button.
 * Secrets (session key, branding token) live in the project's env and are never
 * exposed here.
 */
export interface MailWebmailSummary {
  installed: boolean;
  hostname: string;
  url: string;
  /**
   * `hostname` is "" because the API could not read the routing, not because there
   * is none. Optional for the same reason `projectId` is nullable below: an older
   * API doesn't send it, and absent must read as "routing is known" — the state
   * every release before this one was in.
   */
  routingUnknown?: boolean;
  /**
   * The webmail catalog project that owns this deploy — webmail is an ordinary
   * openship app, and the projects UI is where it's managed.
   *
   * NULL when the webmail was adopted or deployed outside openship: it's running
   * on the box, but there is no project row to link to. That's an offer to install
   * — never a dead end, and never a claim that webmail is down: `installed` alone
   * says that, and an older API that doesn't send this field would otherwise read
   * as a broken install.
   */
  projectId?: string | null;
  /**
   * Deployed by a pre-catalog Openship (webmail as a shipped bundle, not an image).
   * It runs and reports `installed`, but it can only be REPLACED — a redeploy has
   * no pipeline to run — so the UI offers the upgrade instead of staying silent.
   */
  legacy?: boolean;
}

/** What kind of mail engine the box runs, and whether it's serving. */
export interface MailEngineState {
  flavor: "container" | "host" | "none";
  running: boolean;
}

/**
 * The two codes the API's mail-engine gate raises (`MailEngineUnavailableError`),
 * meaning "this failed because nothing is serving mail on the box" rather than
 * anything about the request. Every mail-admin request can fail this way, so the
 * predicate lives here instead of being re-derived per tab — and it matches on the
 * CODE, never the message.
 */
const ENGINE_UNAVAILABLE_CODES = ["MAIL_ENGINE_NOT_INSTALLED", "MAIL_ENGINE_NOT_RUNNING"];

export function isMailEngineUnavailable(err: unknown): boolean {
  const code = getApiErrorCode(err);
  return !!code && ENGINE_UNAVAILABLE_CODES.includes(code);
}

export interface MailSetupStatus {
  active: boolean;
  serverId?: string;
  domain?: string;
  currentStep?: number;
  startedAt?: number;
  finishedAt?: number;
  dnsRecords?: Record<string, unknown>;
  /**
   * Whether the operator has clicked "I've set the records - continue" on
   * a prior visit. False while the install is paused at the DKIM hold;
   * flips true once they ack so subsequent retries don't pause again.
   */
  dnsAcknowledged?: boolean;
  /**
   * Whether the operator has acknowledged the PTR (reverse DNS) gate that
   * follows DNS ack. PTRs are at the VPS provider, not the DNS provider -
   * separate gate to avoid mixing the two.
   */
  ptrAcknowledged?: boolean;
  credentials?: MailCredentials;
  /** Webmail deploy record. Absent when no webmail is deployed yet. */
  webmail?: MailWebmailSummary;
  /**
   * Live mail-engine topology, probed on the same connection that read the state
   * file. `container` = the openship-mail engine; `host` = a LEGACY systemd
   * Postfix/Dovecot install (every mail box provisioned before the engine image);
   * `none` = nothing serving mail on the box at all.
   *
   * ABSENT means "we couldn't look" (server unreachable, probe failed) — never
   * treat a missing field as "no engine", or an SSH hiccup renders a serving box
   * as broken.
   */
  engine?: MailEngineState;
  steps: MailStepStatus[];
  /** Server-buffered log lines, rehydrated on page reload. */
  logs?: MailSessionLogLine[];
  /** Step the user should resume from after a failure / port conflict. */
  resumeStep?: number;
  /** Last failure message - populated when a step failed or conflict halted. */
  errorMessage?: string;
}

// ─── Webmail deploy types ────────────────────────────────────────────────────

export interface WebmailTargetOption {
  kind: "mail" | "server" | "opshcloud";
  serverId: string;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  /** MX priority. Other record types ignore this. */
  priority?: number;
  /** False = optional helper, not required for mail delivery. */
  required?: boolean;
}

export interface DnsRecords {
  // Host records - pre-install requirement (A) + optional IPv6 (AAAA).
  // Surfaced as cards for completeness even though A is already in place
  // by the time the user sees them.
  a?: DnsRecord;
  aaaa?: DnsRecord;
  // Required for mail delivery
  mx: DnsRecord;
  spf: DnsRecord;
  dkim: DnsRecord;
  dmarc: DnsRecord;
  /**
   * Extra records beyond the fixed set — e.g. the outbound-relay send-hop
   * records (SES DKIM CNAMEs + MAIL FROM). Rendered after the standard records.
   */
  extraRecords?: DnsRecord[];
}

// ─── Port conflict types ─────────────────────────────────────────────────────

export interface PortUsage {
  port: number;
  pid: number;
  process: string;
  command: string;
  isDocker: boolean;
  containerName?: string;
}

export interface PortResolution {
  id: string;
  label: string;
  description: string;
  destructive: boolean;
}

export interface PortConflict {
  port: number;
  usage: PortUsage;
  type: "traefik" | "known" | "unknown";
  serviceName?: string;
  resolutions: PortResolution[];
}

// ─── SSE event types ─────────────────────────────────────────────────────────

export interface MailSSEStepStart {
  event: "step_start";
  stepId: number;
  key: string;
  label: string;
}

export interface MailSSELog {
  event: "log";
  stepId: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface MailSSEStepDone {
  event: "step_done";
  stepId: number;
  success: boolean;
  message: string;
  warning?: string;
  data?: Record<string, unknown>;
}

export interface MailSSEDnsRecords {
  event: "dns_records";
  records: DnsRecords;
}

export interface MailSSEComplete {
  event: "complete";
  success: boolean;
  domain: string;
  mailDomain: string;
  finishedAt: number;
  webmailUrl: string;
  adminUrl: string;
}

export interface MailSSEError {
  event: "error";
  message: string;
  resumeStep?: number;
  /**
   * The step the failure is attributed to. Present on every `error` frame — for
   * a failure that happens AROUND the step loop (state read/write, a dead
   * executor) it's the step that was about to run, so the step UI can mark it
   * failed instead of the page falling back to the empty form (#492).
   */
  stepId?: number;
}

export interface MailSSEPortConflict {
  event: "port_conflict";
  portConflicts: PortConflict[];
}

/**
 * DKIM hold-and-continue gate. Emitted after step 11 (DKIM keys) when the
 * user hasn't yet acknowledged DNS records. The install pauses until the
 * user calls `mailApi.acknowledgeDns(...)` and then re-POSTs to /mail/setup
 * with `startStep = resumeStep`.
 */
export interface MailSSEDnsPending {
  event: "dns_pending";
  records: DnsRecords;
  resumeStep: number;
}

/**
 * PTR (reverse-DNS) hold gate. Emitted AFTER `dns_pending` is resolved.
 * PTRs are configured at the VPS provider's panel - separate from the
 * DNS provider - so this gate gets its own banner to avoid mixing them.
 */
export interface MailSSEPtrPending {
  event: "ptr_pending";
  ipv4: string;
  ipv6: string | null;
  target: string;
  resumeStep: number;
}

export type MailSSEEvent =
  | MailSSEStepStart
  | MailSSELog
  | MailSSEStepDone
  | MailSSEDnsRecords
  | MailSSEDnsPending
  | MailSSEPtrPending
  | MailSSEComplete
  | MailSSEError
  | MailSSEPortConflict;

// ─── API client ──────────────────────────────────────────────────────────────

export const mailApi = {
  /** Get list of all setup steps */
  getSteps: () =>
    api.get<{ steps: MailSetupStep[]; total: number }>(endpoints.mail.steps),

  /**
   * Get current setup status for a server. State lives ON the target
   * VPS now (not in openship's DB), so a serverId is required to know
   * whose state we're reading. Returns the "no install" shape if the
   * server can't be reached or the state file doesn't exist.
   */
  getStatus: (serverId?: string) =>
    api.get<MailSetupStatus>(
      serverId
        ? `${endpoints.mail.status}?serverId=${encodeURIComponent(serverId)}`
        : endpoints.mail.status,
    ),

  /**
   * List every server that has a mail install (state file) on disk. Used by
   * the /emails page to short-circuit the picker when there's exactly one
   * mail server provisioned. Servers without a state file or unreachable
   * over SSH are omitted; the dashboard treats this list as the authoritative
   * "which servers are mail servers" set.
   */
  listMailServers: () =>
    api.get<{
      servers: Array<{
        id: string;
        name: string;
        host: string;
        port: number;
        user: string;
        domain: string | null;
        completed: boolean;
        active: boolean;
        // The step an incomplete install paused at (null once complete / never
        // halted) + its human label, so the list can show "Stopped · step N".
        resumeStep: number | null;
        resumeStepLabel: string | null;
      }>;
    }>(endpoints.mail.servers),

  /**
   * Scan a server for an EXISTING mail install whose orchestrator state was
   * lost (e.g. a rebuilt desktop). Read-only.
   */
  scan: (serverId: string) =>
    api.post<{
      serverId: string;
      iredmailInstalled: boolean;
      hasState: boolean;
      domain: string | null;
      installComplete: boolean;
      webmailPresent: boolean;
      adoptable: boolean;
    }>(endpoints.mail.scan, { serverId }),

  /**
   * Re-adopt a mail server detected by `scan` — repopulates the dashboard's
   * record from the on-server state. Idempotent; nothing changes on the server.
   */
  adopt: (serverId: string) =>
    api.post<{ success: boolean; serverId: string; domain: string; completed: boolean }>(
      endpoints.mail.adopt,
      { serverId },
    ),

  /**
   * Start or resume the mail setup wizard.
   * Returns an EventSource for SSE streaming.
   */
  startSetup: (
    serverId: string,
    domain: string,
    startStep?: number,
    config?: { adminPassword: string; storageBackend?: "mariadb" | "postgresql" },
  ): EventSource => {
    const url = new URL(endpoints.mail.setup, getApiBaseUrl());

    // We POST to start the setup, which returns SSE
    // We use fetch + ReadableStream approach for POST-based SSE
    const body = JSON.stringify({
      serverId,
      domain,
      ...(startStep ? { startStep } : {}),
      ...(config ? { config } : {}),
    });

    // Store body for the streaming function
    const es = new EventSource(url.toString());
    // EventSource only supports GET - we need a custom approach
    // See streamSetup below for the POST+SSE pattern
    es.close();

    // Not usable directly - use streamSetup instead
    return es;
  },

  /**
   * Stream setup progress via POST + SSE using fetch ReadableStream.
   */
  streamSetup: async (
    serverId: string,
    domain: string,
    startStep: number | undefined,
    config: { adminPassword: string; storageBackend?: "mariadb" | "postgresql" } | undefined,
    onEvent: (event: MailSSEEvent) => void,
    onDone?: () => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const url = new URL(endpoints.mail.setup, getApiBaseUrl());
    // Direct fetch bypasses the standard api client, so we must attach
    // X-Organization-Id ourselves — otherwise the server scopes by
    // cookie (`activeOrganizationId`) only, which can be stale in a
    // multi-tab session and resolve to the wrong org.
    const orgId = getActiveOrganizationId();
    const setupHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (orgId) setupHeaders["X-Organization-Id"] = orgId;
    const res = await fetch(url.toString(), {
      method: "POST",
      credentials: "include",
      headers: setupHeaders,
      body: JSON.stringify({
        serverId,
        domain,
        ...(startStep ? { startStep } : {}),
        ...(config ? { config } : {}),
      }),
      signal,
    });

    // A non-2xx here means setup never started — the API decided that before
    // the stream existed (#492). Raise the same `ApiError` the standard client
    // raises so callers unwrap it with getApiErrorMessage/getApiErrorCode;
    // throwing the raw body put a JSON blob in front of the operator.
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep as string */
      }
      throw new ApiError(res.status, res.statusText, body);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let eventType = "";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          eventData = line.slice(5).trim();
        } else if (line === "" && eventType && eventData) {
          try {
            const parsed = JSON.parse(eventData);
            onEvent({ event: eventType, ...parsed } as MailSSEEvent);
          } catch {
            // Skip malformed events
          }
          eventType = "";
          eventData = "";
        }
      }
    }

    onDone?.();
  },

  /** Cancel a running setup */
  cancelSetup: () =>
    api.post<{ ok: boolean; message: string }>(endpoints.mail.cancelSetup),

  /**
   * Wipe the on-server state file. Use after purging or reimaging the VPS
   * so the dashboard stops showing stale "step 9 complete" data.
   */
  resetSetup: (serverId: string) =>
    api.post<{ ok: boolean }>(endpoints.mail.resetSetup, { serverId }),

  /**
   * Stop managing a mail server: drops only the mail_servers DB row so
   * /emails stops listing it. The mail stack + on-server state file are
   * left intact, so it can be re-adopted later via scan + adopt. Use to
   * clear a stale/corrupted registry entry.
   */
  forget: (serverId: string) =>
    api.delete<{ ok: boolean }>(endpoints.mail.forgetServer(serverId)),

  /**
   * Mark DNS records as configured for a (server, domain) session - releases
   * the install past the DKIM hold step. The caller should follow this with
   * a `streamSetup(..., startStep = resumeStep)` to actually resume.
   */
  acknowledgeDns: (serverId: string, domain: string) =>
    api.post<{ ok: boolean }>(endpoints.mail.acknowledgeDns, {
      serverId,
      domain,
    }),

  /**
   * Mark PTR (reverse DNS) as configured - releases the install past the
   * VPS-provider gate that runs after DNS ack. Same call shape as DNS ack.
   */
  acknowledgePtr: (serverId: string) =>
    api.post<{ ok: boolean }>(endpoints.mail.acknowledgePtr, {
      serverId,
    }),

  /**
   * Rotate the postmaster password. Hashes via doveadm on the server and
   * UPDATEs `vmail.mailbox` directly. Refuses if a setup is currently
   * running against this server.
   */
  setPostmasterPassword: (serverId: string, password: string) =>
    api.post<{ ok: boolean }>(endpoints.mail.setPostmasterPassword, {
      serverId,
      password,
    }),

  /**
   * Live health of every mail-core daemon on the target server. The Mail
   * tab polls this every ~10 s to render running/stopped pills.
   */
  getHealth: (serverId: string, refreshReachability = false) =>
    api.get<MailHealthResponse>(
      `${endpoints.mail.health(serverId)}${refreshReachability ? "?refreshReachability=1" : ""}`,
    ),

  /** Standalone port 80/443 scan */
  checkPorts: (serverId: string) =>
    api.post<{ conflicts: PortConflict[]; free: boolean }>(endpoints.mail.portsCheck, {
      serverId,
    }),

  /** Resolve a specific port conflict */
  resolvePorts: (serverId: string, conflict: PortConflict, resolutionId: string) =>
    api.post<{ success: boolean; message: string }>(endpoints.mail.portsResolve, {
      serverId,
      conflict,
      resolutionId,
    }),

  // ── Webmail deploy ────────────────────────────────────────────────────────
  webmail: {
    /** Hosts the webmail can be deployed to (mail server + other openship servers). */
    listTargets: (serverId: string) =>
      api.get<{ options: WebmailTargetOption[] }>(
        `${endpoints.mail.webmail.targets}?serverId=${encodeURIComponent(serverId)}`,
      ),

    /**
     * Create a project + deployment for this webmail install and kick off
     * the deploy in the background. The dashboard then redirects to
     * /build/[deploymentId] and subscribes to the standard SSE endpoint.
     *
     * `target` discriminator:
     *   { kind: "self", serverId } - host on an openship-managed server
     *   { kind: "cloud" }          - host on Opshcloud
     *
     * A pre-catalog webmail (`MailWebmailSummary.legacy`) can't be redeployed:
     * without `replaceLegacy` the API answers 409 `LEGACY_WEBMAIL`, and with it the
     * old install is torn down first. Only ever sent from a screen that told the
     * operator what goes.
     */
    deployAsProject: (input: {
      mailServerId: string;
      hostname: string;
      target:
        | { kind: "self"; serverId: string }
        | { kind: "cloud" };
      replaceLegacy?: boolean;
    }) =>
      api.post<{ deploymentId: string; projectId: string }>(
        endpoints.mail.webmail.deployProject,
        input,
      ),

    /**
     * Deploy the Zero webmail UI pointed at an EXTERNAL IMAP/SMTP backend —
     * the "Connect existing" provider path (a provider for send + a read IMAP
     * host, or a fully custom backend). No mail server / iRedMail required.
     *
     * `provider` is the label the operator picked; the hosts are used verbatim.
     */
    deployExternal: (input: {
      hostname: string;
      backend: {
        provider: RelayProviderId;
        imapHost: string;
        imapPort: number;
        smtpHost: string;
        smtpPort: number;
      };
      /** A binding only — see AppDestination. "local" is derived server-side. */
      target: { deployTarget: "server" | "cloud"; serverId?: string };
    }) =>
      api.post<{ deploymentId: string; projectId: string }>(
        endpoints.mail.webmail.deployExternal,
        input,
      ),
  },
};
